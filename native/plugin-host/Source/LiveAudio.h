// Native live audio: opens the audio interface directly (JACK/ALSA on Linux, WASAPI/DirectSound/ASIO
// on Windows) and runs the monitored track's chain (amp, cabinet, EQ, effects, sends, master) on
// the input with only the device's own buffering as latency. It also records the clean input with
// sample-accurate timestamps so the app can line takes up with the song.
//
// Song playback still comes from the app's own engine in this stage; both play through the same
// output (the system mixes them), so recordings are aligned with clock timestamps rather than by
// sharing one audio clock.

#pragma once

#include "Dsp.h"
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>
#include <functional>

namespace bb
{
using namespace juce;

inline double monotonicSeconds()
{
    return (double) Time::getHighResolutionTicks() / (double) Time::getHighResolutionTicksPerSecond();
}

//==============================================================================
// A virtual interface for automated tests (BB_TEST_AUDIO=1): a click on the input every second,
// rendered in real time by a thread; it measures how long each click takes to reach the output.
class TestDevice final : public AudioIODevice, private Thread
{
public:
    TestDevice() : AudioIODevice ("Test Interface", "Test"), Thread ("bb test audio") {}
    ~TestDevice() override { close(); }

    StringArray getOutputChannelNames() override { return { "Out 1", "Out 2" }; }
    StringArray getInputChannelNames() override  { return { "In 1", "In 2" }; }
    Array<double> getAvailableSampleRates() override { return { 44100.0, 48000.0 }; }
    Array<int> getAvailableBufferSizes() override { return { 64, 128, 256, 512 }; }
    int getDefaultBufferSize() override { return 128; }

    String open (const BigInteger&, const BigInteger&, double sr, int bs) override
    {
        rate = sr > 0 ? sr : 48000;
        block = bs > 0 ? bs : 128;
        isOpen_ = true;
        return {};
    }

    void close() override { stop(); isOpen_ = false; }
    bool isOpen() override { return isOpen_; }
    void start (AudioIODeviceCallback* cb) override
    {
        stop();
        callback = cb;
        cb->audioDeviceAboutToStart (this);
        startThread (Priority::highest);
    }
    void stop() override
    {
        stopThread (2000);
        if (auto* cb = std::exchange (callback, nullptr)) cb->audioDeviceStopped();
    }
    bool isPlaying() override { return callback != nullptr; }
    String getLastError() override { return {}; }
    int getCurrentBufferSizeSamples() override { return block; }
    double getCurrentSampleRate() override { return rate; }
    int getCurrentBitDepth() override { return 32; }
    BigInteger getActiveOutputChannels() const override { BigInteger b; b.setRange (0, 2, true); return b; }
    BigInteger getActiveInputChannels() const override  { BigInteger b; b.setRange (0, 2, true); return b; }
    int getOutputLatencyInSamples() override { return 0; }
    int getInputLatencyInSamples() override { return 0; }

    // Frames from each input click to the first output sample that answers it.
    std::vector<int> latencies() { const ScopedLock l (statsLock); return measured; }

private:
    double rate = 48000;
    int block = 128;
    bool isOpen_ = false;
    AudioIODeviceCallback* callback = nullptr;
    CriticalSection statsLock;
    std::vector<int> measured;

    void run() override
    {
        AudioBuffer<float> in (2, block), out (2, block);
        int64 frame = 0, lastClick = -1;
        bool waiting = false;
        auto next = Time::getMillisecondCounterHiRes();
        while (! threadShouldExit())
        {
            in.clear();
            for (int i = 0; i < block; ++i)
                if ((frame + i) % (int64) rate == (int64) (rate / 10))
                {
                    in.setSample (0, i, 0.5f);
                    lastClick = frame + i;
                    waiting = true;
                }
            out.clear();
            const float* ins[] = { in.getReadPointer (0), in.getReadPointer (1) };
            float* outs[] = { out.getWritePointer (0), out.getWritePointer (1) };
            callback->audioDeviceIOCallbackWithContext (ins, 2, outs, 2, block, {});
            if (waiting)
                for (int i = 0; i < block; ++i)
                    if (std::abs (out.getSample (0, i)) > 0.01f || std::abs (out.getSample (1, i)) > 0.01f)
                    {
                        const ScopedLock l (statsLock);
                        measured.push_back ((int) (frame + i - lastClick));
                        waiting = false;
                        break;
                    }
            frame += block;
            next += 1000.0 * block / rate;
            const auto wait = next - Time::getMillisecondCounterHiRes();
            if (wait > 0) Thread::sleep ((int) wait);
        }
    }
};

class TestDeviceType final : public AudioIODeviceType
{
public:
    TestDeviceType() : AudioIODeviceType ("Test") {}
    void scanForDevices() override {}
    StringArray getDeviceNames (bool) const override { return { "Test Interface" }; }
    int getDefaultDeviceIndex (bool) const override { return 0; }
    int getIndexOfDevice (AudioIODevice*, bool) const override { return 0; }
    bool hasSeparateInputsAndOutputs() const override { return false; }
    AudioIODevice* createDevice (const String&, const String&) override { return new TestDevice(); }
};

//==============================================================================
class LiveAudio final : private AudioIODeviceCallback, private Timer
{
public:
    // send(json) and sendInput(bytes) deliver messages to the app.
    LiveAudio (std::function<void (const var&)> sendJsonFn, std::function<void (const void*, size_t)> sendInputFn)
        : sendJson (std::move (sendJsonFn)), sendInput (std::move (sendInputFn))
    {
        devices.getAvailableDeviceTypes();   // creates the system's own types (adding ours first would stop that)
        if (SystemStats::getEnvironmentVariable ("BB_TEST_AUDIO", {}).isNotEmpty())
            devices.addAudioDeviceType (std::make_unique<TestDeviceType>());
        formats.registerBasicFormats();
    }

    ~LiveAudio() override { close(); }

    //==============================================================================
    var listDevices()
    {
        Array<var> types;
        for (auto* t : devices.getAvailableDeviceTypes())
        {
            t->scanForDevices();
            auto* o = new DynamicObject();
            o->setProperty ("type", t->getTypeName());
            o->setProperty ("inputs", toVar (t->getDeviceNames (true)));
            o->setProperty ("outputs", toVar (t->getDeviceNames (false)));
            o->setProperty ("separateInputsAndOutputs", t->hasSeparateInputsAndOutputs());
            types.add (var (o));
        }
        auto* r = new DynamicObject();
        r->setProperty ("types", types);
        r->setProperty ("current", status());
        return var (r);
    }

    // Opens a device: {type, input, output, rate, buffer}. Empty names pick the type's defaults.
    String open (const var& m)
    {
        close();
        String type = m["type"];
        if (type.isEmpty()) type = preferredType();
        if (type.isNotEmpty()) devices.setCurrentAudioDeviceType (type, true);
        auto* t = devices.getCurrentDeviceTypeObject();
        if (t == nullptr) return "No audio system available";
        t->scanForDevices();
        AudioDeviceManager::AudioDeviceSetup setup;
        setup.inputDeviceName = m["input"].toString().isNotEmpty() ? m["input"].toString() : t->getDeviceNames (true)[t->getDefaultDeviceIndex (true)];
        setup.outputDeviceName = m["output"].toString().isNotEmpty() ? m["output"].toString() : t->getDeviceNames (false)[t->getDefaultDeviceIndex (false)];
        setup.sampleRate = (double) m.getProperty ("rate", 0.0);
        setup.bufferSize = (int) m.getProperty ("buffer", 0);
        setup.useDefaultInputChannels = true;
        setup.useDefaultOutputChannels = true;
        const auto error = devices.initialise (2, 2, nullptr, false, {}, &setup);
        if (error.isNotEmpty()) return error;
        if (devices.getCurrentAudioDevice() == nullptr) return "The audio device couldn't be opened";
        devices.addAudioCallback (this);
        startTimerHz (20);
        return {};
    }

    // The lowest-latency system that's actually present: JACK (PipeWire's, on most current Linux
    // desktops) over ALSA; WASAPI's low-latency shared mode on Windows (ASIO only when chosen, since
    // it takes the interface over).
    String preferredType()
    {
        for (auto name : { "JACK", "Windows Audio (Low Latency Mode)", "Windows Audio", "ALSA", "DirectSound" })
            for (auto* t : devices.getAvailableDeviceTypes())
                if (t->getTypeName() == name)
                {
                    t->scanForDevices();
                    if (! t->getDeviceNames (false).isEmpty())
                        return name;
                }
        return {};
    }

    void close()
    {
        stopTimer();
        devices.removeAudioCallback (this);
        devices.closeAudioDevice();
    }

    var status()
    {
        auto* o = new DynamicObject();
        if (auto* d = devices.getCurrentAudioDevice())
        {
            o->setProperty ("open", true);
            o->setProperty ("type", d->getTypeName());
            o->setProperty ("input", devices.getAudioDeviceSetup().inputDeviceName);
            o->setProperty ("output", devices.getAudioDeviceSetup().outputDeviceName);
            o->setProperty ("rate", d->getCurrentSampleRate());
            o->setProperty ("buffer", d->getCurrentBufferSizeSamples());
            o->setProperty ("inputLatency", d->getInputLatencyInSamples());
            o->setProperty ("outputLatency", d->getOutputLatencyInSamples());
            o->setProperty ("inputChannels", toVar (d->getInputChannelNames()));
            o->setProperty ("rates", toVar (d->getAvailableSampleRates()));
            o->setProperty ("buffers", toVar (d->getAvailableBufferSizes()));
            o->setProperty ("xruns", d->getXRunCount());
        }
        else
            o->setProperty ("open", false);
        return var (o);
    }

    //==============================================================================
    // Monitoring settings: {on, input: left|right|stereo, track: {...}, bpm, masterVolume}.
    void setMonitor (const var& m)
    {
        auto settings = parseTrack (m["track"]);
        const AudioBuffer<float>* ir = settings.amp.cab == "ir" ? loadIr (settings.amp.irPath) : nullptr;
        const ScopedLock l (pendingLock);
        pending = settings;
        pendingIr = ir;
        pendingBpm = (double) m.getProperty ("bpm", 120.0);
        pendingMaster = (float) (double) m.getProperty ("masterVolume", 0.0);
        hasPending = true;
        inputMode = m["input"].toString() == "right" ? 1 : m["input"].toString() == "stereo" ? 2 : 0;
        monitoring = (bool) m.getProperty ("on", false);
    }

    // Recording keeps the clean input; the timer streams it to the app as it comes in.
    void startRecording()
    {
        recordFirstFrame = -1;
        ringRead = ringWrite.load();
        recording = true;
    }

    void stopRecording()
    {
        recording = false;
        timerCallback();   // flush what's left
        sendJson (makeEvent ("recordStopped", 0));
    }

    // Where the device clock is: a recent callback's first frame and when it ran (monotonic seconds).
    var clock()
    {
        auto* o = new DynamicObject();
        o->setProperty ("now", monotonicSeconds());
        o->setProperty ("frame", (double) syncFrame.load());
        o->setProperty ("frameTime", syncTime.load());
        o->setProperty ("rate", rate);
        return var (o);
    }

    var testStats()
    {
        Array<var> out;
        if (auto* d = dynamic_cast<TestDevice*> (devices.getCurrentAudioDevice()))
            for (auto v : d->latencies()) out.add (v);
        return out;
    }

    //==============================================================================
    // Runs the monitoring chain offline over a mono buffer (for checking it matches the app).
    static AudioBuffer<float> renderOffline (const var& m, const AudioBuffer<float>& input, double sr, LiveAudio& owner)
    {
        TrackChain chain;
        SendEffects sends;
        MasterBus master;
        const int block = 256;
        chain.prepare (sr, block);
        sends.prepare (sr, block);
        master.prepare (sr);
        auto settings = owner.parseTrack (m["track"]);
        const AudioBuffer<float>* ir = settings.amp.cab == "ir" ? owner.loadIr (settings.amp.irPath) : nullptr;
        chain.configure (settings, ir);
        sends.setTempo ((double) m.getProperty ("bpm", 120.0));
        master.setVolumeDb ((float) (double) m.getProperty ("masterVolume", 0.0));
        // Convolution loads impulse responses in the background; give them a moment.
        Thread::sleep (300);
        const int n = input.getNumSamples();
        AudioBuffer<float> out (2, n), bus (4, block);
        out.clear();
        for (int pos = 0; pos < n; pos += block)
        {
            const int len = jmin (block, n - pos);
            bus.clear();
            chain.process (input.getReadPointer (0, pos), len, out.getWritePointer (0, pos), out.getWritePointer (1, pos),
                           bus.getWritePointer (0), bus.getWritePointer (1), bus.getWritePointer (2), bus.getWritePointer (3));
            sends.process (bus.getWritePointer (0), bus.getWritePointer (1), bus.getWritePointer (2), bus.getWritePointer (3),
                           out.getWritePointer (0, pos), out.getWritePointer (1, pos), len);
            master.process (out.getWritePointer (0, pos), out.getWritePointer (1, pos), len);
        }
        return out;
    }

private:
    std::function<void (const var&)> sendJson;
    std::function<void (const void*, size_t)> sendInput;
    AudioDeviceManager devices;
    AudioFormatManager formats;

    double rate = 48000;
    int block = 512;
    TrackChain chain;
    SendEffects sends;
    MasterBus master;
    AudioBuffer<float> mono, bus;

    CriticalSection pendingLock;
    TrackSettings pending;
    const AudioBuffer<float>* pendingIr = nullptr;
    double pendingBpm = 120;
    float pendingMaster = 0;
    bool hasPending = false;
    std::atomic<int> inputMode { 0 };
    std::atomic<bool> monitoring { false }, recording { false };

    std::map<String, std::unique_ptr<AudioBuffer<float>>> irs;

    std::atomic<int64> frameCount { 0 }, syncFrame { 0 };
    std::atomic<double> syncTime { 0 };
    std::atomic<float> peak { 0 };
    std::atomic<int64> recordFirstFrame { -1 };
    std::atomic<size_t> recordBase { 0 };

    static var toVar (const StringArray& a) { Array<var> v; for (auto& s : a) v.add (s); return v; }
    template <typename T> static var toVar (const Array<T>& a) { Array<var> v; for (auto x : a) v.add (x); return v; }

    TrackSettings parseTrack (const var& t)
    {
        TrackSettings s;
        auto num = [&] (const var& o, const char* k, float def) { return o.hasProperty (k) ? (float) (double) o[k] : def; };
        s.eqLow = num (t, "eqLow", 0); s.eqMid = num (t, "eqMid", 0); s.eqHigh = num (t, "eqHigh", 0);
        s.tone = num (t, "tone", 1); s.drive = num (t, "drive", 0); s.volumeDb = num (t, "volume", -4);
        s.pan = num (t, "pan", 0); s.reverb = num (t, "reverb", 0); s.echo = num (t, "echo", 0);
        s.mute = (bool) t.getProperty ("mute", false);
        const var a = t["amp"];
        if (a.isObject())
        {
            s.amp.model = a.getProperty ("model", "off").toString();
            const var cab = a["cab"];
            s.amp.cab = cab.isBool() ? ((bool) cab ? String() : String ("off")) : cab.toString();
            s.amp.irPath = a["ir"].isObject() ? a["ir"]["path"].toString() : String();
            s.amp.gain = num (a, "gain", 0.5f); s.amp.bass = num (a, "bass", 0.5f); s.amp.mid = num (a, "mid", 0.5f);
            s.amp.treble = num (a, "treble", 0.5f); s.amp.presence = num (a, "presence", 0.5f);
            s.amp.gate = num (a, "gate", 0.3f); s.amp.level = num (a, "level", 0.5f);
            s.amp.sustain = num (a, "sustain", -1.0f);
        }
        return s;
    }

    // Cabinet impulse responses, decoded once (mono: the first channel).
    const AudioBuffer<float>* loadIr (const String& path)
    {
        if (path.isEmpty()) return nullptr;
        auto it = irs.find (path);
        if (it != irs.end()) return it->second.get();
        std::unique_ptr<AudioFormatReader> reader (formats.createReaderFor (File (path)));
        if (reader == nullptr) return nullptr;
        auto buf = std::make_unique<AudioBuffer<float>> (1, (int) std::min<int64> (reader->lengthInSamples, (int64) reader->sampleRate * 10));
        reader->read (buf.get(), 0, buf->getNumSamples(), 0, true, false);
        // Match the device's rate (simple linear resampling is plenty for an IR).
        if (std::abs (reader->sampleRate - rate) > 0.5 && reader->sampleRate > 0)
        {
            const double ratio = reader->sampleRate / rate;
            const int len = (int) (buf->getNumSamples() / ratio);
            auto res = std::make_unique<AudioBuffer<float>> (1, len);
            for (int i = 0; i < len; ++i)
            {
                const double p = i * ratio;
                const int k = (int) p;
                const float f = (float) (p - k);
                const float a = buf->getSample (0, k), b = k + 1 < buf->getNumSamples() ? buf->getSample (0, k + 1) : 0.0f;
                res->setSample (0, i, a + (b - a) * f);
            }
            buf = std::move (res);
        }
        auto* raw = buf.get();
        irs[path] = std::move (buf);
        return raw;
    }

    //==============================================================================
    void audioDeviceAboutToStart (AudioIODevice* d) override
    {
        rate = d->getCurrentSampleRate();
        block = jmax (16, d->getCurrentBufferSizeSamples());
        chain.prepare (rate, block * 2);
        sends.prepare (rate, block * 2);
        master.prepare (rate);
        mono.setSize (1, block * 2);
        bus.setSize (5, block * 2);
        // frameCount keeps running: it's our clock, paired with syncTime for the app.
        const ScopedLock l (pendingLock);
        hasPending = true;  // configure the fresh chain
    }

    void audioDeviceStopped() override {}

    void audioDeviceIOCallbackWithContext (const float* const* in, int numIn, float* const* out, int numOut, int n,
                                           const AudioIODeviceCallbackContext&) override
    {
        const auto start = frameCount.load();
        syncFrame = start;
        syncTime = monotonicSeconds();
        frameCount = start + n;

        // Apply new settings between blocks (never mid-block).
        {
            const ScopedTryLock l (pendingLock);
            if (l.isLocked() && hasPending)
            {
                chain.configure (pending, pendingIr);
                sends.setTempo (pendingBpm);
                master.setVolumeDb (pendingMaster);
                hasPending = false;
            }
        }

        const float* inL = numIn > 0 && in[0] != nullptr ? in[0] : nullptr;
        const float* inR = numIn > 1 && in[1] != nullptr ? in[1] : inL;
        auto* x = mono.getWritePointer (0);
        const int mode = inputMode;
        float pk = 0;
        for (int i = 0; i < n; ++i)
        {
            const float l = inL ? inL[i] : 0.0f, r = inR ? inR[i] : 0.0f;
            x[i] = mode == 0 ? l : mode == 1 ? r : (l + r) * 0.5f;
            pk = jmax (pk, std::abs (x[i]));
        }
        peak = jmax (peak.load(), pk);

        if (recording)
        {
            if (recordFirstFrame.load() < 0)
            {
                recordBase = ringWrite.load();
                recordFirstFrame = start;
            }
            pushRecorded (x, n);
        }

        for (int c = 0; c < numOut; ++c)
            if (out[c] != nullptr) FloatVectorOperations::clear (out[c], n);
        if (! monitoring || numOut == 0) return;
        bus.clear();
        auto* L = out[0];
        float* RR = numOut > 1 && out[1] != nullptr ? out[1] : bus.getWritePointer (4);
        chain.process (x, n, L, RR, bus.getWritePointer (0), bus.getWritePointer (1), bus.getWritePointer (2), bus.getWritePointer (3));
        sends.process (bus.getWritePointer (0), bus.getWritePointer (1), bus.getWritePointer (2), bus.getWritePointer (3), L, RR, n);
        master.process (L, RR, n);
    }

    // The recording ring: mono samples; drained to the app by the timer.
    std::vector<float> ring = std::vector<float> ((size_t) 1 << 20);
    std::atomic<size_t> ringWrite { 0 }, ringRead { 0 };

    void pushRecorded (const float* x, int n)
    {
        auto w = ringWrite.load();
        for (int i = 0; i < n; ++i) ring[(w + (size_t) i) & (ring.size() - 1)] = x[i];
        ringWrite = w + (size_t) n;
    }

    void timerCallback() override
    {
        // Input level for the meter.
        sendJson (makeEvent ("inputLevel", peak.exchange (0)));
        // Recorded audio: [i64 first frame][f64 frame time][f64 frame of that time][f32 samples...]
        auto r = ringRead.load(), w = ringWrite.load();
        if (w == r || recordFirstFrame.load() < 0) return;
        if (w - r > ring.size()) r = w - ring.size();
        const auto count = (size_t) (w - r);
        std::vector<char> msg (24 + count * 4);
        const int64 first = recordFirstFrame.load() + (int64) (r - recordBase.load());
        const double t = syncTime.load(), f = (double) syncFrame.load();
        memcpy (msg.data(), &first, 8);
        memcpy (msg.data() + 8, &t, 8);
        memcpy (msg.data() + 16, &f, 8);
        auto* dst = reinterpret_cast<float*> (msg.data() + 24);
        for (size_t i = 0; i < count; ++i) dst[i] = ring[(r + i) & (ring.size() - 1)];
        ringRead = w;
        sendInput (msg.data(), msg.size());
    }

    static var makeEvent (const char* name, float value)
    {
        auto* o = new DynamicObject();
        o->setProperty ("event", name);
        o->setProperty ("peak", value);
        return var (o);
    }
};

} // namespace bb
