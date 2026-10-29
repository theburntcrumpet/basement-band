// bb-plugin-host — Basement Band's plugin helper.
//
//   bb-plugin-host --find [extra folders...]   lists plugin files/ids as JSON: [{format, file}]
//   bb-plugin-host --scan <format> <file>      describes the plugins in one file as JSON
//   bb-plugin-host                             serves render requests over stdin/stdout
//
// Messages in both directions are framed as  [u32 length][u8 type][payload], little-endian.
//   'J'  UTF-8 JSON (commands from the app; replies and events from us)
//   'R'  render request:  u32 seq, u32 inst, u32 frames, f64 bpm, f64 ppq, u8 playing, 3 pad,
//                         u32 count, then count × {u32 offset, u8 status, u8 data1, u8 data2, u8 pad}
//   'A'  rendered audio:  u32 seq, u32 inst, u32 frames, u32 channels, then planar float32
//   'I'  recorded input:  i64 first frame, f64 clock time, f64 frame at that time, then float32 mono
//   'S'  sample upload:   u32 id length, id (UTF-8), f64 rate, u32 channels, u32 frames, planar float32
//
// Song playback (Song.h): song:set, transport:play, transport:stop, transport:seek, live:note,
// song:render (offline, for export and checks).
//
// Live audio (see LiveAudio.h): audio:devices, audio:open, audio:close, audio:status, audio:clock,
// monitor:set, record:start, record:stop, monitor:render, test:stats.
//
// Rendering happens on the stdin thread, in order, so the app can stream ahead of playback.
// Loading, editor windows and state run on the message thread, as plugins expect.

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include "LiveAudio.h"

#include <atomic>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>

#if JUCE_WINDOWS
 #define NOMINMAX
 #define WIN32_LEAN_AND_MEAN
 #include <windows.h>
#else
 #include <unistd.h>
#endif

using namespace juce;

//==============================================================================
// Raw stdio (works the same for console and windowed builds on every platform).

static bool readExact (void* dst, size_t n)
{
    auto* p = static_cast<char*> (dst);
    while (n > 0)
    {
       #if JUCE_WINDOWS
        DWORD got = 0;
        if (! ReadFile (GetStdHandle (STD_INPUT_HANDLE), p, (DWORD) n, &got, nullptr) || got == 0)
            return false;
       #else
        auto got = ::read (0, p, n);
        if (got <= 0)
            return false;
       #endif
        p += got;
        n -= (size_t) got;
    }
    return true;
}

static std::mutex outLock;

static void writeExact (const void* src, size_t n)
{
    auto* p = static_cast<const char*> (src);
    while (n > 0)
    {
       #if JUCE_WINDOWS
        DWORD put = 0;
        if (! WriteFile (GetStdHandle (STD_OUTPUT_HANDLE), p, (DWORD) n, &put, nullptr) || put == 0)
            return;
       #else
        auto put = ::write (1, p, n);
        if (put <= 0)
            return;
       #endif
        p += put;
        n -= (size_t) put;
    }
}

static void sendFrame (char type, const void* data, size_t size)
{
    std::lock_guard<std::mutex> lock (outLock);
    const uint32_t len = (uint32_t) size + 1;
    writeExact (&len, 4);
    writeExact (&type, 1);
    if (size > 0)
        writeExact (data, size);
}

static void sendJson (const var& v)
{
    auto text = JSON::toString (v, true);
    sendFrame ('J', text.toRawUTF8(), text.getNumBytesAsUTF8());
}

static var object (std::initializer_list<std::pair<const char*, var>> props)
{
    auto* o = new DynamicObject();
    for (auto& [k, v] : props)
        o->setProperty (k, v);
    return var (o);
}

static void reply (const var& req, bool ok, const String& error = {}, var extra = {})
{
    auto out = extra.isObject() ? extra : object ({});
    out.getDynamicObject()->setProperty ("req", req);
    out.getDynamicObject()->setProperty ("ok", ok);
    if (error.isNotEmpty())
        out.getDynamicObject()->setProperty ("error", error);
    sendJson (out);
}

//==============================================================================

static void addFormats (AudioPluginFormatManager& m)
{
    addDefaultFormatsToManager (m);
}

static var describe (const PluginDescription& d)
{
    return object ({
        { "name", d.name },
        { "manufacturer", d.manufacturerName },
        { "category", d.category },
        { "format", d.pluginFormatName },
        { "file", d.fileOrIdentifier },
        { "id", d.createIdentifierString() },
        { "isInstrument", d.isInstrument },
        { "version", d.version },
        { "xml", d.createXml()->toString (XmlElement::TextFormat().singleLine().withoutHeader()) },
    });
}

//==============================================================================

struct PlayHead final : public AudioPlayHead
{
    double bpm = 120, ppq = 0, rate = 48000;
    int64 samples = 0;
    bool playing = false;

    Optional<PositionInfo> getPosition() const override
    {
        PositionInfo info;
        info.setBpm (bpm);
        info.setPpqPosition (ppq);
        info.setTimeInSamples (samples);
        info.setTimeInSeconds ((double) samples / rate);
        info.setIsPlaying (playing);
        return info;
    }
};

struct Instance;

struct EditorWindow final : public DocumentWindow
{
    EditorWindow (Instance& o, const String& title, AudioProcessorEditor* editor)
        : DocumentWindow (title, Colours::black, DocumentWindow::closeButton | DocumentWindow::minimiseButton),
          owner (o)
    {
        setUsingNativeTitleBar (true);
        setContentOwned (editor, true);
        setResizable (editor->isResizable(), false);
        centreWithSize (getWidth(), getHeight());
    }

    void closeButtonPressed() override;

    Instance& owner;
};

// Members are destroyed bottom-up: the editor window goes before the plugin, which goes before the
// play head it points at.
struct Instance
{
    uint32_t id = 0;
    PlayHead head;
    AudioBuffer<float> buffer;
    MidiBuffer midi;
    std::unique_ptr<AudioPluginInstance> plugin;
    std::unique_ptr<EditorWindow> window;
    int maxBlock = 2048;
    std::mutex lock;   // held while rendering, so state changes and unloading wait for a block to finish
};

void EditorWindow::closeButtonPressed()
{
    setVisible (false);
    sendJson (object ({ { "event", "editorClosed" }, { "inst", (int) owner.id } }));
}

// Lets the song engine play a loaded plugin directly on the audio thread.
struct PluginLink final : public bb::PluginSource
{
    PluginLink (std::shared_ptr<Instance> i, bool offlineRender) : inst (std::move (i)), offline (offlineRender) {}

    void process (float* L, float* R, int n, const MidiBuffer& midi, double bpm, double ppq, bool playing) override
    {
        // Live, never wait on the audio thread (skip a block instead); offline renders wait their turn.
        std::unique_lock<std::mutex> l (inst->lock, std::defer_lock);
        if (offline) l.lock();
        else if (! l.try_lock()) return;
        if (inst->plugin == nullptr) return;
        auto& plugin = *inst->plugin;
        const int channels = jmax (2, plugin.getTotalNumInputChannels(), plugin.getTotalNumOutputChannels());
        const int outs = plugin.getTotalNumOutputChannels();
        inst->head.bpm = bpm;
        inst->head.ppq = ppq;
        inst->head.playing = playing;
        int done = 0;
        while (done < n)
        {
            const int len = jmin (n - done, inst->maxBlock);
            inst->buffer.setSize (channels, len, false, false, true);
            inst->buffer.clear();
            inst->midi.clear();
            inst->midi.addEvents (midi, done, len, -done);
            plugin.processBlock (inst->buffer, inst->midi);
            for (int c = 0; c < 2; ++c)
            {
                const int src = outs == 0 ? -1 : jmin (c, outs - 1);
                if (src >= 0) FloatVectorOperations::add (c == 0 ? L + done : R + done, inst->buffer.getReadPointer (src), len);
            }
            inst->head.samples += len;
            inst->head.ppq += len / inst->head.rate * bpm / 60.0;
            done += len;
        }
    }

    std::shared_ptr<Instance> inst;
    bool offline;
};

//==============================================================================

class Host final : private Thread
{
public:
    Host() : Thread ("bb-plugin-host stdin")
    {
        addFormats (formats);
        startThread (Priority::highest);
    }

    ~Host() override
    {
        stopThread (200);
        live.reset();
        std::lock_guard<std::mutex> l (mapLock);
        instances.clear();
    }

private:
    AudioPluginFormatManager formats;
    std::unique_ptr<bb::LiveAudio> live;      // created on the message thread when first used
    std::atomic<bb::LiveAudio*> liveRaw { nullptr };
    std::mutex mapLock;

    bb::LiveAudio& liveAudio()
    {
        if (live == nullptr)
        {
            live = std::make_unique<bb::LiveAudio> ([] (const var& v) { sendJson (v); },
                                                    [] (const void* d, size_t n) { sendFrame ('I', d, n); });
            live->song.plugins = [this] (int id) -> std::shared_ptr<bb::PluginSource> {
                auto inst = find ((uint32_t) id);
                return inst ? std::make_shared<PluginLink> (inst, false) : nullptr;
            };
            liveRaw = live.get();
        }
        return *live;
    }
    std::map<uint32_t, std::shared_ptr<Instance>> instances;

    std::shared_ptr<Instance> find (uint32_t id)
    {
        std::lock_guard<std::mutex> l (mapLock);
        auto it = instances.find (id);
        return it == instances.end() ? nullptr : it->second;
    }

    void run() override
    {
        std::vector<char> data;
        while (! threadShouldExit())
        {
            uint32_t len = 0;
            if (! readExact (&len, 4) || len == 0 || len > (64u << 20))
                break;
            data.resize (len);
            if (! readExact (data.data(), len))
                break;
            const char type = data[0];
            if (type == 'R')
                render (data.data() + 1, len - 1);
            else if (type == 'S')
                addSample (data.data() + 1, len - 1);
            else if (type == 'J')
                command (JSON::parse (String::fromUTF8 (data.data() + 1, (int) len - 1)));
        }
        // The app closed our stdin (or went away): we're done.
        MessageManager::callAsync ([] { JUCEApplicationBase::quit(); });
    }

    // Decoded sample data for the song's instruments.
    void addSample (const char* p, size_t size)
    {
        if (size < 4) return;
        uint32_t idLen; memcpy (&idLen, p, 4);
        if (size < 4 + idLen + 16) return;
        const String id = String::fromUTF8 (p + 4, (int) idLen);
        const char* q = p + 4 + idLen;
        double sr; uint32_t channels, frames;
        memcpy (&sr, q, 8); memcpy (&channels, q + 8, 4); memcpy (&frames, q + 12, 4);
        if (channels == 0 || channels > 2 || size < 4 + idLen + 16 + (size_t) channels * frames * 4) return;
        auto sample = std::make_shared<bb::Sample>();
        sample->rate = sr;
        sample->data.setSize ((int) channels, (int) frames);
        for (uint32_t c = 0; c < channels; ++c)
            memcpy (sample->data.getWritePointer ((int) c), q + 16 + (size_t) c * frames * 4, (size_t) frames * 4);
        MessageManager::callAsync ([this, id, sample] { liveAudio().samples.add (id, sample); });
    }

    //==============================================================================
    void render (const char* p, size_t size)
    {
        if (size < 36)
            return;
        auto u32 = [&] (size_t at) { uint32_t v; memcpy (&v, p + at, 4); return v; };
        auto f64 = [&] (size_t at) { double v; memcpy (&v, p + at, 8); return v; };
        const uint32_t seq = u32 (0), instId = u32 (4), frames = jmin (u32 (8), (uint32_t) (1 << 16));
        const double bpm = f64 (12), ppq = f64 (20);
        const bool playing = p[28] != 0;
        const uint32_t count = u32 (32);
        if (size < 36 + (size_t) count * 8)
            return;

        std::vector<float> out ((size_t) frames * 2, 0.0f);
        if (auto inst = find (instId))
        {
            std::lock_guard<std::mutex> l (inst->lock);
            if (inst->plugin != nullptr)
                process (*inst, frames, bpm, ppq, playing, p + 36, count, out);
        }

        std::vector<char> msg (16 + out.size() * sizeof (float));
        const uint32_t header[4] = { seq, instId, frames, 2 };
        memcpy (msg.data(), header, 16);
        memcpy (msg.data() + 16, out.data(), out.size() * sizeof (float));
        sendFrame ('A', msg.data(), msg.size());
    }

    static void process (Instance& inst, uint32_t frames, double bpm, double ppq, bool playing,
                         const char* events, uint32_t count, std::vector<float>& out)
    {
        auto& plugin = *inst.plugin;
        const int channels = jmax (2, plugin.getTotalNumInputChannels(), plugin.getTotalNumOutputChannels());
        const int outs = plugin.getTotalNumOutputChannels();
        inst.head.bpm = bpm;
        inst.head.playing = playing;
        uint32_t done = 0, e = 0;
        while (done < frames)
        {
            const int n = (int) std::min<uint32_t> (frames - done, (uint32_t) inst.maxBlock);
            inst.buffer.setSize (channels, n, false, false, true);
            inst.buffer.clear();
            inst.midi.clear();
            for (; e < count; ++e)
            {
                uint32_t offset;
                memcpy (&offset, events + e * 8, 4);
                if (offset >= done + (uint32_t) n)
                    break;
                const auto* b = reinterpret_cast<const uint8_t*> (events + e * 8 + 4);
                const int size = (b[0] & 0xf0) == 0xc0 || (b[0] & 0xf0) == 0xd0 ? 2 : 3;
                inst.midi.addEvent (b, size, (int) std::max<int64> (0, (int64) offset - done));
            }
            inst.head.ppq = ppq + (double) done / inst.head.rate * bpm / 60.0;
            plugin.processBlock (inst.buffer, inst.midi);
            for (int ch = 0; ch < 2; ++ch)
            {
                const int src = outs == 0 ? -1 : jmin (ch, outs - 1);
                if (src >= 0)
                    memcpy (out.data() + (size_t) ch * frames + done, inst.buffer.getReadPointer (src), (size_t) n * sizeof (float));
            }
            inst.head.samples += n;
            done += (uint32_t) n;
        }
    }

    // Plugin windows on Linux go through X11 (XWayland on Wayland desktops), where the display scale
    // JUCE detects can be wrong. The app knows the real one (or the user's choice) and sends it; each
    // editor is scaled by whatever correction gets there. For VST3 plugins JUCE passes this on as the
    // plugin's content scale (the desktop-wide scale factor isn't, so that wouldn't resize them).
    // Open windows are closed, so editors are rebuilt at the new size the next time they're shown.
    float editorScale = 1.0f;

    void setScale (double wanted)
    {
        const auto* display = Desktop::getInstance().getDisplays().getPrimaryDisplay();
        const double detected = display != nullptr && display->scale > 0 ? display->scale : 1.0;
        const auto factor = (float) jlimit (0.25, 4.0, wanted / detected);
        if (approximatelyEqual (factor, editorScale))
            return;
        editorScale = factor;
        std::vector<std::shared_ptr<Instance>> all;
        {
            std::lock_guard<std::mutex> l (mapLock);
            for (auto& [id, inst] : instances)
                all.push_back (inst);
        }
        for (auto& inst : all)
            if (inst->window != nullptr)
            {
                inst->window.reset();
                sendJson (object ({ { "event", "editorClosed" }, { "inst", (int) inst->id } }));
            }
    }

    //==============================================================================
    void command (const var& msg)
    {
        const String cmd = msg["cmd"];
        const var req = msg["req"];
        const auto instId = (uint32_t) (int) msg["inst"];

        if (cmd == "load")
        {
            // Plugins are created on the message thread; renders before then are silent.
            MessageManager::callAsync ([this, msg, req, instId]
            {
                PluginDescription desc;
                auto xml = parseXML (msg["xml"].toString());
                if (xml == nullptr || ! desc.loadFromXml (*xml))
                    return reply (req, false, "Bad plugin description");
                const double rate = msg["rate"];
                const int block = jlimit (64, 8192, (int) msg.getProperty ("block", 2048));
                String error;
                auto plugin = formats.createPluginInstance (desc, rate, block, error);
                if (plugin == nullptr)
                    return reply (req, false, error.isNotEmpty() ? error : "The plugin could not be loaded");
                auto inst = std::make_shared<Instance>();
                inst->id = instId;
                inst->maxBlock = block;
                inst->head.rate = rate;
                plugin->disableNonMainBuses();
                plugin->setPlayHead (&inst->head);
                plugin->setNonRealtime (msg.getProperty ("offline", false));
                plugin->prepareToPlay (rate, block);
                const String state = msg["state"];
                if (state.isNotEmpty())
                {
                    MemoryBlock mb;
                    if (mb.fromBase64Encoding (state))
                        plugin->setStateInformation (mb.getData(), (int) mb.getSize());
                }
                inst->plugin = std::move (plugin);
                const auto latency = inst->plugin->getLatencySamples();
                const bool hasEditor = inst->plugin->hasEditor();
                const auto outs = inst->plugin->getTotalNumOutputChannels();
                {
                    std::lock_guard<std::mutex> l (mapLock);
                    instances[instId] = inst;
                }
                reply (req, true, {}, object ({ { "latency", latency }, { "hasEditor", hasEditor }, { "outputs", outs } }));
            });
        }
        else if (cmd == "unload")
        {
            MessageManager::callAsync ([this, instId]
            {
                std::shared_ptr<Instance> inst;
                {
                    std::lock_guard<std::mutex> l (mapLock);
                    auto it = instances.find (instId);
                    if (it == instances.end())
                        return;
                    inst = it->second;
                    instances.erase (it);
                }
                inst->window.reset();
                std::lock_guard<std::mutex> l (inst->lock);
                inst->plugin->releaseResources();
                inst->plugin.reset();
            });
        }
        else if (cmd == "show" || cmd == "hide")
        {
            const String title = msg["title"];
            const double scale = msg.getProperty ("scale", 0.0);
            MessageManager::callAsync ([this, cmd, instId, title, req, scale]
            {
                auto inst = find (instId);
                if (inst == nullptr)
                    return reply (req, false, "No such plugin");
                if (cmd == "hide")
                {
                    if (inst->window != nullptr)
                        inst->window->setVisible (false);
                    return reply (req, true);
                }
                if (scale > 0)
                    setScale (scale);
                if (inst->window == nullptr)
                {
                    auto* editor = inst->plugin->hasEditor() ? inst->plugin->createEditorAndMakeActive() : nullptr;
                    if (editor == nullptr)
                        editor = new GenericAudioProcessorEditor (*inst->plugin);
                    editor->setScaleFactor (editorScale);
                    inst->window = std::make_unique<EditorWindow> (*inst, title, editor);
                }
                if (title.isNotEmpty())
                    inst->window->setName (title);
                inst->window->setVisible (true);
                inst->window->toFront (true);
                const auto* display = Desktop::getInstance().getDisplays().getPrimaryDisplay();
                const double physical = display != nullptr ? display->scale : 1.0;
                reply (req, true, {}, object ({ { "width", (int) std::lround (inst->window->getWidth() * physical) },
                                                { "height", (int) std::lround (inst->window->getHeight() * physical) },
                                                { "scale", physical } }));
            });
        }
        else if (cmd == "getState")
        {
            MessageManager::callAsync ([this, instId, req]
            {
                auto inst = find (instId);
                if (inst == nullptr)
                    return reply (req, false, "No such plugin");
                MemoryBlock mb;
                inst->plugin->getStateInformation (mb);
                reply (req, true, {}, object ({ { "state", mb.toBase64Encoding() } }));
            });
        }
        else if (cmd == "setState")
        {
            const String state = msg["state"];
            MessageManager::callAsync ([this, instId, state, req]
            {
                auto inst = find (instId);
                MemoryBlock mb;
                if (inst == nullptr || ! mb.fromBase64Encoding (state))
                    return reply (req, false, "No such plugin");
                std::lock_guard<std::mutex> l (inst->lock);
                inst->plugin->setStateInformation (mb.getData(), (int) mb.getSize());
                reply (req, true);
            });
        }
        else if (cmd == "reset")
        {
            // All notes off and clear tails (after Stop, or before rendering from a new position).
            if (auto inst = find (instId))
            {
                std::lock_guard<std::mutex> l (inst->lock);
                inst->plugin->reset();
                inst->head.samples = 0;
            }
            reply (req, true);
        }
        else if (cmd == "live:note")
        {
            // Straight to the audio thread: this is the latency you feel when playing.
            if (auto* l = liveRaw.load())
                l->song.liveNote (msg["track"].toString(), (int) msg["midi"], (float) (double) msg.getProperty ("velocity", 0.8), (bool) msg.getProperty ("on", true));
        }
        else if (cmd.startsWith ("song:") || cmd.startsWith ("transport:"))
        {
            MessageManager::callAsync ([this, cmd, msg, req]
            {
                auto& l = liveAudio();
                if (cmd == "song:set") { l.song.setSong (msg["song"]); return reply (req, true); }
                if (cmd == "transport:play")
                {
                    l.song.play ((double) msg["beat"], (int64) (double) msg.getProperty ("delaySamples", 0.0), (bool) msg.getProperty ("countIn", false));
                    return reply (req, true);
                }
                if (cmd == "transport:stop") { l.song.stop(); return reply (req, true); }
                if (cmd == "transport:seek") { l.song.seek ((double) msg["beat"]); return reply (req, true); }
                if (cmd == "song:render")
                {
                    // An offline render in a separate engine, sharing the uploaded samples.
                    bb::SongEngine offline (l.samples);
                    offline.irs = l.song.irs;
                    offline.plugins = [this] (int id) -> std::shared_ptr<bb::PluginSource> {
                        auto inst = find ((uint32_t) id);
                        return inst ? std::make_shared<PluginLink> (inst, true) : nullptr;
                    };
                    offline.prepare ((double) msg.getProperty ("rate", 48000.0), 512);
                    offline.setSong (msg["song"]);
                    auto out = offline.render ((double) msg["start"], (double) msg["end"], (double) msg.getProperty ("tail", 2.5));
                    MemoryBlock result;
                    for (int c = 0; c < 2; ++c) result.append (out.getReadPointer (c), sizeof (float) * (size_t) out.getNumSamples());
                    return reply (req, true, {}, object ({ { "frames", out.getNumSamples() }, { "output", Base64::toBase64 (result.getData(), result.getSize()) } }));
                }
                reply (req, false, "Unknown command " + cmd);
            });
        }
        else if (cmd.startsWith ("audio:") || cmd.startsWith ("monitor:") || cmd.startsWith ("record:") || cmd == "test:stats")
        {
            // The clock is answered straight away (its timing is the point); the rest on the message thread.
            if (cmd == "audio:clock")
            {
                if (auto* l = liveRaw.load())
                    return reply (req, true, {}, l->clock());
                return reply (req, false, "Audio isn't open");
            }
            MessageManager::callAsync ([this, cmd, msg, req]
            {
                auto& l = liveAudio();
                if (cmd == "audio:devices") return reply (req, true, {}, l.listDevices());
                if (cmd == "audio:status") return reply (req, true, {}, l.status());
                if (cmd == "audio:open")
                {
                    const auto error = l.open (msg);
                    return error.isEmpty() ? reply (req, true, {}, l.status()) : reply (req, false, error);
                }
                if (cmd == "audio:close") { l.close(); return reply (req, true); }
                if (cmd == "monitor:set") { l.setMonitor (msg); return reply (req, true); }
                if (cmd == "record:start") { l.startRecording(); return reply (req, true); }
                if (cmd == "record:stop") { l.stopRecording(); return reply (req, true); }
                if (cmd == "test:stats") return reply (req, true, {}, object ({ { "latencies", l.testStats() } }));
                if (cmd == "monitor:render")
                {
                    // {track, bpm, masterVolume, rate, input: base64 float32 mono} -> base64 float32 L then R
                    MemoryOutputStream decoded;
                    Base64::convertFromBase64 (decoded, msg["input"].toString());
                    const MemoryBlock in = decoded.getMemoryBlock();
                    AudioBuffer<float> buf (1, (int) (in.getSize() / 4));
                    memcpy (buf.getWritePointer (0), in.getData(), in.getSize());
                    auto out = bb::LiveAudio::renderOffline (msg, buf, (double) msg.getProperty ("rate", 48000.0), l);
                    MemoryBlock result;
                    for (int c = 0; c < 2; ++c) result.append (out.getReadPointer (c), sizeof (float) * (size_t) out.getNumSamples());
                    return reply (req, true, {}, object ({ { "output", Base64::toBase64 (result.getData(), result.getSize()) } }));
                }
                reply (req, false, "Unknown command " + cmd);
            });
        }
        else if (cmd == "ping")
        {
            reply (req, true, {}, object ({ { "version", JUCE_APPLICATION_VERSION_STRING } }));
        }
    }
};

//==============================================================================

class App final : public JUCEApplication
{
public:
    const String getApplicationName() override       { return JUCE_APPLICATION_NAME_STRING; }
    const String getApplicationVersion() override    { return JUCE_APPLICATION_VERSION_STRING; }
    bool moreThanOneInstanceAllowed() override       { return true; }

    void initialise (const String&) override
    {
        auto args = getCommandLineParameterArray();
        if (args.contains ("--find"))
            return finish (find (args));
        if (args.contains ("--scan"))
            return finish (scan (args));
        host = std::make_unique<Host>();
    }

    void shutdown() override { host.reset(); }
    void systemRequestedQuit() override { quit(); }
    void anotherInstanceStarted (const String&) override {}

private:
    std::unique_ptr<Host> host;

    void finish (const String& text)
    {
        auto out = text + "\n";
        writeExact (out.toRawUTF8(), out.getNumBytesAsUTF8());
        setApplicationReturnValue (0);
        quit();
    }

    static String find (const StringArray& args)
    {
        AudioPluginFormatManager formats;
        addFormats (formats);
        Array<var> out;
        for (auto* format : formats.getFormats())
        {
            auto paths = format->getDefaultLocationsToSearch();
            for (int i = args.indexOf ("--find") + 1; i < args.size(); ++i)
                if (File::isAbsolutePath (args[i]) && File (args[i]).exists())
                    paths.add (File (args[i]));
            for (auto& f : format->searchPathsForPlugins (paths, true, false))
                out.add (object ({ { "format", format->getName() }, { "file", f } }));
        }
        return JSON::toString (var (out), true);
    }

    static String scan (const StringArray& args)
    {
        const int at = args.indexOf ("--scan");
        const String formatName = args[at + 1], file = args[at + 2];
        AudioPluginFormatManager formats;
        addFormats (formats);
        Array<var> out;
        for (auto* format : formats.getFormats())
        {
            if (format->getName() != formatName)
                continue;
            OwnedArray<PluginDescription> found;
            format->findAllTypesForFile (found, file);
            for (auto* d : found)
                out.add (describe (*d));
        }
        return JSON::toString (var (out), true);
    }
};

START_JUCE_APPLICATION (App)
