// The native song engine: plays a whole song (tempo map, cycle, every track's instrument through its
// mixer chain, sends and master) in the helper. It mirrors src/engine/engine.js scheduleProject() and
// the instrument classes in instruments.js, so songs sound the same as in the app's own engine.
//
// The app sends the song as JSON (song:set) and the decoded sample data its instruments use (binary
// 'S' frames, at the song's sample rate), so both engines play identical samples.

#pragma once

#include "Dsp.h"
#include <atomic>
#include <map>
#include <memory>
#include <mutex>

namespace bb
{
using namespace juce;

//==============================================================================
// Tempo map (music/tempo.js): steps of tempo at given beats.
struct TempoMap
{
    struct Point { double beat, bpm; };
    std::vector<Point> points { { 0, 120 } };

    void set (double bpm, const var& changes)
    {
        points = { { 0, bpm } };
        std::vector<Point> rest;
        if (auto* a = changes.getArray())
            for (auto& c : *a)
                if ((double) c["beat"] > 1e-9) rest.push_back ({ (double) c["beat"], (double) c["bpm"] });
        std::sort (rest.begin(), rest.end(), [] (auto& x, auto& y) { return x.beat < y.beat; });
        points.insert (points.end(), rest.begin(), rest.end());
    }

    double bpmAt (double beat) const
    {
        size_t i = 0;
        while (i + 1 < points.size() && points[i + 1].beat <= beat + 1e-9) ++i;
        return points[i].bpm;
    }

    double secAt (double beat) const
    {
        double sec = 0;
        for (size_t i = 0; i < points.size(); ++i)
        {
            const double a = points[i].beat, b = i + 1 < points.size() ? points[i + 1].beat : 1e18;
            if (beat <= a) break;
            sec += (std::min (beat, b) - a) * 60.0 / points[i].bpm;
        }
        return sec;
    }

    double beatAt (double sec) const
    {
        double t = 0;
        for (size_t i = 0; i < points.size(); ++i)
        {
            const double spb = 60.0 / points[i].bpm;
            const double next = i + 1 < points.size() ? points[i + 1].beat : 1e18;
            const double seg = (next - points[i].beat) * spb;
            if (sec <= t + seg) return points[i].beat + (sec - t) / spb;
            t += seg;
        }
        return 0;
    }

    double secBetween (double a, double b) const { return secAt (b) - secAt (a); }
};

//==============================================================================
// Decoded samples sent by the app, by id.
struct Sample
{
    double rate = 48000;
    AudioBuffer<float> data;
};

class SamplePool
{
public:
    void add (const String& id, std::shared_ptr<Sample> s) { const ScopedLock l (lock); samples[id] = std::move (s); }
    std::shared_ptr<Sample> get (const String& id) const { const ScopedLock l (lock); auto it = samples.find (id); return it == samples.end() ? nullptr : it->second; }
    bool has (const String& id) const { return get (id) != nullptr; }

private:
    CriticalSection lock;
    std::map<String, std::shared_ptr<Sample>> samples;
};

//==============================================================================
// Tone.js OneShotSource gain envelope: fade in, then a fade out from the stop time. "exponential"
// curves approach the target with time constant ln(t+1)/ln(200) and finish with a linear ramp over
// the last 10% (Param.exponentialApproachValueAtTime), exactly as the app's engine does.
struct FadeEnvelope
{
    enum Stage { attack, hold, release, done };
    bool exponential = true;
    double peak = 1, value = 0, rate = 48000;
    double fadeIn = 0, fadeOut = 0;
    Stage stage = attack;
    int64 t = 0, stopAt = -1;      // samples since start; when the fade out begins
    double from = 0;               // value when the current ramp began

    void start (double gain, double attackSec, double releaseSec, double sr, bool expCurve)
    {
        peak = gain; fadeIn = attackSec; fadeOut = releaseSec; rate = sr; exponential = expCurve;
        t = 0; stopAt = -1; from = 0;
        stage = fadeIn > 0 ? attack : hold;
        value = fadeIn > 0 ? 0 : peak;
    }

    // Schedules (or moves) the fade out to begin `inSamples` from now (Tone's cancelStop + stop).
    void stop (int64 inSamples) { stopAt = t + std::max<int64> (0, inSamples); }

    float next() noexcept
    {
        if (stage != release && stage != done && stopAt >= 0 && t >= stopAt)
        {
            stage = fadeOut > 0 ? release : done;
            from = value;
            if (stage == done) value = 0;
        }
        const double sec = (double) t / rate;
        switch (stage)
        {
            case attack:
                value = ramp (0, peak, sec, fadeIn);
                if (sec >= fadeIn) { stage = hold; value = peak; }
                break;
            case hold: break;
            case release:
            {
                const double s = (double) (t - stopAt) / rate;
                value = ramp (from, 0, s, fadeOut);
                if (s >= fadeOut) { stage = done; value = 0; }
                break;
            }
            case done: value = 0; break;
        }
        ++t;
        return (float) value;
    }

    bool finished() const { return stage == done; }

private:
    double ramp (double a, double b, double s, double len) const
    {
        if (len <= 0) return b;
        if (! exponential) return a + (b - a) * jmin (1.0, s / len);
        const double tc = std::log (len + 1) / std::log (200.0);
        const double knee = len * 0.9;
        const auto approach = [&] (double x) { return b + (a - b) * std::exp (-x / tc); };
        if (s < knee) return approach (s);
        const double atKnee = approach (knee);
        return atKnee + (b - atKnee) * jmin (1.0, (s - knee) / (len - knee));
    }
};

//==============================================================================
// Something that makes sound from notes. Times are sample offsets within the block being rendered.
struct NoteEvent { int offset; int midi; float velocity; int64 durationSamples; };   // durationSamples < 0: until noteOff

class Instrument
{
public:
    virtual ~Instrument() = default;
    virtual void prepare (double sampleRate, int maxBlock) = 0;
    virtual void noteOn (const NoteEvent&) = 0;
    virtual void noteOff (int midi, int offset) = 0;
    virtual void allNotesOff (int offset) = 0;
    // Renders n samples, starting with events at the given offsets already queued.
    virtual void render (float* left, float* right, int n) = 0;
};

// A sample voice: plays a buffer at a playback rate with a fade envelope, from a given offset in the block.
struct SampleVoice
{
    std::shared_ptr<Sample> sample;
    double pos = 0, step = 1;
    int delay = 0;            // samples to wait before starting (the event's offset in the block)
    int64 endAt = -1;         // natural end (samples after start), Tone's start(..., duration)
    FadeEnvelope env;
    float gain = 1;
    int midi = -1, group = 0;
    bool active = false;
    int64 age = 0;

    void render (float* L, float* R, int n)
    {
        if (! active) return;
        const auto& d = sample->data;
        const int len = d.getNumSamples();
        const float* l = d.getReadPointer (0);
        const float* r = d.getNumChannels() > 1 ? d.getReadPointer (1) : l;
        for (int i = 0; i < n; ++i)
        {
            if (delay > 0) { --delay; continue; }
            if (endAt >= 0 && env.t == endAt && env.stopAt < 0) env.stop (0);
            const float g = env.next() * gain;
            const int k = (int) pos;
            if (k + 1 >= len || env.finished()) { active = false; return; }
            const float f = (float) (pos - k);
            L[i] += (l[k] + (l[k + 1] - l[k]) * f) * g;
            R[i] += (r[k] + (r[k + 1] - r[k]) * f) * g;
            pos += step;
        }
    }
};

class VoicePool
{
public:
    std::vector<SampleVoice> voices = std::vector<SampleVoice> (192);
    int64 counter = 0;

    SampleVoice& take()
    {
        SampleVoice* best = nullptr;
        for (auto& v : voices)
        {
            if (! v.active) { best = &v; break; }
            if (best == nullptr || v.age < best->age) best = &v;   // steal the oldest
        }
        best->age = ++counter;
        best->active = true;
        return *best;
    }

    void render (float* L, float* R, int n) { for (auto& v : voices) v.render (L, R, n); }
};

//==============================================================================
// Tone.Sampler: the nearest sample (preferring the one above at equal distance), repitched; gain is
// the velocity; attack/release fades with the instrument's curve.
class SamplerInstrument final : public Instrument
{
public:
    SamplerInstrument (std::map<int, std::shared_ptr<Sample>> zonesIn, double attackSec, double releaseSec, bool expCurve, float volumeDb)
        : zones (std::move (zonesIn)), attack (attackSec), release (releaseSec), exponential (expCurve), volume (Decibels::decibelsToGain (volumeDb)) {}

    void prepare (double sr, int) override { rate = sr; }

    void noteOn (const NoteEvent& e) override
    {
        if (zones.empty()) return;
        int diff = 0;
        bool found = false;
        for (int interval = 0; interval < 96 && ! found; ++interval)
        {
            if (zones.count (e.midi + interval)) { diff = -interval; found = true; }
            else if (zones.count (e.midi - interval)) { diff = interval; found = true; }
        }
        if (! found) return;
        auto sample = zones[e.midi - diff];
        auto& v = pool.take();
        const double playbackRate = std::pow (2.0, diff / 12.0);
        v.sample = sample;
        v.pos = 0;
        v.step = playbackRate * sample->rate / rate;
        v.delay = e.offset;
        v.midi = e.midi;
        v.gain = volume;
        v.env.start (e.velocity, attack, release, rate, exponential);
        // Natural end: the buffer's duration at this playback rate.
        v.endAt = (int64) std::llround (sample->data.getNumSamples() / v.step);
        if (e.durationSamples >= 0) v.env.stop (e.durationSamples + e.offset - v.delay);
    }

    void noteOff (int midi, int offset) override
    {
        for (auto& v : pool.voices)
            if (v.active && v.midi == midi && v.env.stopAt < 0) v.env.stop (offset - v.delay);
    }

    void allNotesOff (int offset) override { for (auto& v : pool.voices) if (v.active) v.env.stop (offset - v.delay); }

    void render (float* L, float* R, int n) override { pool.render (L, R, n); }

private:
    std::map<int, std::shared_ptr<Sample>> zones;
    double attack, release, rate = 48000;
    bool exponential;
    float volume;
    VoicePool pool;
};

//==============================================================================
// instruments.js DrumKit: one-shots with velocity layers, a 40 ms linear fade at the end, and closed
// hats choking the open hat.
class KitInstrument final : public Instrument
{
public:
    KitInstrument (std::map<int, std::vector<std::shared_ptr<Sample>>> piecesIn, float volumeDb)
        : pieces (std::move (piecesIn)), volume (Decibels::decibelsToGain (volumeDb)) {}

    void prepare (double sr, int) override { rate = sr; }

    void noteOn (const NoteEvent& e) override
    {
        auto it = pieces.find (e.midi);
        if (it == pieces.end() || it->second.empty()) return;
        const auto& layers = it->second;
        const auto count = (int) layers.size();
        auto sample = layers[(size_t) jmin (count - 1, (int) std::floor (e.velocity * count))];
        if (e.midi == 42 || e.midi == 44)
            for (auto& v : pool.voices)
                if (v.active && v.midi == 46) v.env.stop (e.offset - v.delay);
        auto& v = pool.take();
        v.sample = sample;
        v.pos = 0;
        v.step = sample->rate / rate;
        v.delay = e.offset;
        v.midi = e.midi;
        v.gain = volume;
        const float g = count > 1 ? 0.55f + 0.45f * e.velocity : 0.15f + 0.85f * e.velocity;
        v.env.start (g, 0, 0.04, rate, false);
        v.endAt = (int64) std::llround (sample->data.getNumSamples() / v.step);
    }

    void noteOff (int, int) override {}
    void allNotesOff (int offset) override { for (auto& v : pool.voices) if (v.active && v.midi == 46) v.env.stop (offset - v.delay); }
    void render (float* L, float* R, int n) override { pool.render (L, R, n); }

private:
    std::map<int, std::vector<std::shared_ptr<Sample>>> pieces;
    double rate = 48000;
    float volume;
    VoicePool pool;
};

//==============================================================================
// A track: its notes, instrument and mixer chain.
struct SongNote { double beat, lengthBeats; int midi; float velocity; };

class TrackPlayer
{
public:
    String id;
    std::unique_ptr<Instrument> instrument;
    String instrumentKey;                  // rebuild the instrument when this changes
    std::shared_ptr<const std::vector<SongNote>> notes;   // sorted by beat
    TrackChain chain;
    TrackSettings settings;
    bool settingsChanged = true;
    float peak = 0;

    void prepare (double rate, int block)
    {
        chain.prepare (rate, block);
        if (instrument) instrument->prepare (rate, block);
        mixL.setSize (1, block); mixR.setSize (1, block); mono.setSize (1, block);
        settingsChanged = true;
    }

    // Renders the instrument and runs the chain, adding to out and the send buses.
    void render (int n, float* outL, float* outR, float* revL, float* revR, float* echoL, float* echoR)
    {
        if (settingsChanged) { chain.configure (settings, nullptr); settingsChanged = false; }
        auto* l = mixL.getWritePointer (0);
        auto* r = mixR.getWritePointer (0);
        auto* m = mono.getWritePointer (0);
        FloatVectorOperations::clear (l, n);
        FloatVectorOperations::clear (r, n);
        if (instrument) instrument->render (l, r, n);
        // Tone.Channel's panner takes one channel: the track is mixed to mono before it's panned.
        for (int i = 0; i < n; ++i) m[i] = 0.5f * (l[i] + r[i]);
        // The meter reads the channel output (post fader).
        FloatVectorOperations::clear (l, n);
        FloatVectorOperations::clear (r, n);
        chain.process (m, n, l, r, revL, revR, echoL, echoR);
        float pk = peak;
        for (int i = 0; i < n; ++i) { outL[i] += l[i]; outR[i] += r[i]; pk = jmax (pk, std::abs (l[i]), std::abs (r[i])); }
        peak = pk;
    }

private:
    AudioBuffer<float> mixL, mixR, mono;
};

//==============================================================================
// The metronome: Tone.Synth (triangle, 1 ms attack, 50 ms decay to silence) at -10 dB, straight to
// the output like the app's click.
class Click
{
public:
    void prepare (double sr) { rate = sr; }
    void trigger (double freq, float velocity, int offset)
    {
        phase = 0; inc = freq / rate; delay = offset; t = 0; peak = velocity * Decibels::decibelsToGain (-10.0f); on = true;
    }
    void render (float* L, float* R, int n)
    {
        if (! on) return;
        const double tc = std::log (0.05 + 1) / std::log (200.0);
        for (int i = 0; i < n; ++i)
        {
            if (delay > 0) { --delay; continue; }
            const double s = t++ / rate;
            double env = s < 0.001 ? s / 0.001 : std::exp (-(s - 0.001) / tc);
            if (s > 0.25) { on = false; return; }
            const double tri = 4 * std::abs (phase - std::floor (phase + 0.5)) - 1;
            phase += inc;
            const float v = (float) (tri * env * peak);
            L[i] += v; R[i] += v;
        }
    }

private:
    double rate = 48000, phase = 0, inc = 0, t = 0;
    float peak = 0;
    int delay = 0;
    bool on = false;
};

//==============================================================================
// The whole song: transport, tracks, sends, master and metronome. setSong() and the transport calls
// come from the message thread; process() runs on the audio thread and picks changes up between
// blocks.
class SongEngine
{
public:
    explicit SongEngine (SamplePool& p) : pool (p) {}

    void prepare (double sampleRate, int maxBlock)
    {
        const ScopedLock l (lock);
        rate = sampleRate;
        block = maxBlock;
        sends.prepare (rate, block);
        master.prepare (rate);
        click.prepare (rate);
        for (auto& t : tracks) t->prepare (rate, block);
        bus.setSize (6, block);
    }

    // The song from the app (see src/engine/native-engine.js songForNative()).
    void setSong (const var& song)
    {
        TempoMap newTempo;
        newTempo.set ((double) song.getProperty ("bpm", 120.0), song["tempoChanges"]);
        std::vector<std::shared_ptr<TrackPlayer>> next;
        std::map<String, std::shared_ptr<TrackPlayer>> existing;
        {
            const ScopedLock l (lock);
            for (auto& t : tracks) existing[t->id] = t;
        }
        struct Change { std::shared_ptr<TrackPlayer> track; std::unique_ptr<Instrument> instrument; String key; bool newInstrument; TrackSettings settings; std::shared_ptr<const std::vector<SongNote>> notes; };
        std::vector<Change> changes;
        if (auto* arr = song["tracks"].getArray())
            for (auto& tv : *arr)
            {
                const String id = tv["id"];
                auto it = existing.find (id);
                auto track = it != existing.end() ? it->second : std::make_shared<TrackPlayer>();
                if (it == existing.end())
                {
                    track->id = id;
                    track->prepare (rate, block);
                }
                Change c { track, nullptr, {}, false, parseSettings (tv), parseNotes (tv["notes"]) };
                const var inst = tv["instrument"];
                c.key = JSON::toString (inst, true);
                if (c.key != track->instrumentKey)
                {
                    c.newInstrument = true;
                    c.instrument = buildInstrument (inst);
                    if (c.instrument) c.instrument->prepare (rate, block);
                }
                next.push_back (track);
                changes.push_back (std::move (c));
            }
        const ScopedLock l (lock);
        tempo = newTempo;
        tracks = next;
        for (auto& c : changes)
        {
            if (c.newInstrument) { trash.push_back (std::move (c.track->instrument)); c.track->instrument = std::move (c.instrument); c.track->instrumentKey = c.key; }
            c.track->settings = c.settings;
            c.track->settingsChanged = true;
            c.track->notes = c.notes;
        }
        cycleOn = (bool) song["cycle"].getProperty ("on", false);
        cycleStart = (double) song["cycle"].getProperty ("start", 0.0);
        cycleEnd = (double) song["cycle"].getProperty ("end", 4.0);
        masterDb = (float) (double) song.getProperty ("masterVolume", 0.0);
        metronome = (bool) song.getProperty ("metronome", false);
        meterNum = jmax (1, (int) song["meter"].getProperty ("num", 4));
        meterPulse = (double) song["meter"].getProperty ("pulse", 1.0);
        meterCompound = (bool) song["meter"].getProperty ("compound", false);
        masterChanged = true;
        trashOld();
    }

    // Starts playing from `beat` after `delaySamples` (a count-in plays clicks during the wait).
    void play (double beat, int64 delaySamples, bool countIn)
    {
        const ScopedLock l (lock);
        position = beat;
        waitSamples = std::max<int64> (0, delaySamples);
        countInClicks = countIn;
        countInSamples = 0;
        playing = true;
    }

    void stop()
    {
        const ScopedLock l (lock);
        playing = false;
        for (auto& t : tracks) if (t->instrument) t->instrument->allNotesOff (0);
    }

    void seek (double beat) { const ScopedLock l (lock); position = beat; }

    // Notes played live (keyboard, MIDI), from any thread; applied at the start of the next block.
    void liveNote (const String& trackId, int midi, float velocity, bool on)
    {
        const ScopedLock l (liveLock);
        live.push_back ({ trackId, midi, velocity, on });
    }

    double currentBeat() const { return beatNow.load(); }
    bool isPlaying() const { return playingNow.load(); }

    // Track meters since the last call (post-fader peaks), plus the master's.
    var takeMeters()
    {
        auto* o = new DynamicObject();
        const ScopedLock l (lock);
        for (auto& t : tracks) { o->setProperty (t->id, t->peak); t->peak = 0; }
        o->setProperty ("master", masterPeak.exchange (0));
        return var (o);
    }

    // Renders a block, adding to L/R.
    void process (float* L, float* R, int n)
    {
        const ScopedTryLock l (lock);
        if (! l.isLocked()) return;
        if (masterChanged) { master.setVolumeDb (masterDb); masterChanged = false; }
        auto* outL = bus.getWritePointer (0); auto* outR = bus.getWritePointer (1);
        auto* revL = bus.getWritePointer (2); auto* revR = bus.getWritePointer (3);
        auto* echoL = bus.getWritePointer (4); auto* echoR = bus.getWritePointer (5);
        bus.clear (0, n);

        applyLiveNotes();
        if (playing) schedule (n);
        sends.setTempo (tempo.bpmAt (position));
        for (auto& t : tracks)
            t->render (n, outL, outR, revL, revR, echoL, echoR);
        sends.process (revL, revR, echoL, echoR, outL, outR, n);
        master.process (outL, outR, n);
        float pk = masterPeak;
        for (int i = 0; i < n; ++i) pk = jmax (pk, std::abs (outL[i]), std::abs (outR[i]));
        masterPeak = pk;
        click.render (outL, outR, n);
        FloatVectorOperations::add (L, outL, n);
        FloatVectorOperations::add (R, outR, n);
        beatNow = position;
        playingNow = playing && waitSamples == 0;
    }

    // Offline: renders [start, end) plus a tail, at the engine's rate.
    AudioBuffer<float> render (double start, double end, double tail)
    {
        const int total = (int) std::ceil ((tempo.secBetween (start, end) + tail) * rate);
        const int stopAt = (int) std::llround (tempo.secBetween (start, end) * rate);
        AudioBuffer<float> out (2, total);
        out.clear();
        play (start, 0, false);
        for (int pos = 0; pos < total; pos += block)
        {
            const int n = jmin (block, total - pos);
            if (playing && pos + n > stopAt)
            {
                // Stop scheduling exactly at the end of the range; notes already playing finish their
                // own lengths, as when the app's transport stops an export.
                const int first = jmax (0, stopAt - pos);
                if (first > 0) process (out.getWritePointer (0, pos), out.getWritePointer (1, pos), first);
                { const ScopedLock l (lock); playing = false; }
                if (n - first > 0) process (out.getWritePointer (0, pos + first), out.getWritePointer (1, pos + first), n - first);
                continue;
            }
            process (out.getWritePointer (0, pos), out.getWritePointer (1, pos), n);
        }
        return out;
    }

    const TempoMap& tempoMap() const { return tempo; }

private:
    SamplePool& pool;
    CriticalSection lock, liveLock;
    double rate = 48000;
    int block = 512;
    TempoMap tempo;
    std::vector<std::shared_ptr<TrackPlayer>> tracks;
    std::vector<std::unique_ptr<Instrument>> trash;
    SendEffects sends;
    MasterBus master;
    Click click;
    AudioBuffer<float> bus;

    bool playing = false, countInClicks = false, cycleOn = false, metronome = false, meterCompound = false, masterChanged = true;
    double position = 0, cycleStart = 0, cycleEnd = 4, meterPulse = 1;
    int meterNum = 4;
    float masterDb = 0;
    int64 waitSamples = 0, countInSamples = 0;
    std::atomic<double> beatNow { 0 };
    std::atomic<bool> playingNow { false };
    std::atomic<float> masterPeak { 0 };

    struct LiveNote { String track; int midi; float velocity; bool on; };
    std::vector<LiveNote> live;

    void trashOld() { if (trash.size() > 8) trash.clear(); }

    void applyLiveNotes()
    {
        const ScopedTryLock l (liveLock);
        if (! l.isLocked() || live.empty()) return;
        for (auto& e : live)
            for (auto& t : tracks)
                if (t->id == e.track && t->instrument)
                {
                    if (e.on) t->instrument->noteOn ({ 0, e.midi, e.velocity, -1 });
                    else t->instrument->noteOff (e.midi, 0);
                }
        live.clear();
    }

    // Queues this block's notes and clicks, advancing the position (wrapping round the cycle).
    void schedule (int n)
    {
        int done = 0;
        if (waitSamples > 0)
        {
            // Count-in: clicks on each pulse of one bar before the song starts.
            const int w = (int) std::min<int64> (waitSamples, n);
            if (countInClicks)
            {
                const double spb = 60.0 / tempo.bpmAt (position);
                const auto pulseSamples = (int64) std::llround (meterPulse * spb * rate);
                for (int i = 0; i < w; ++i)
                {
                    const int64 s = countInSamples + i;
                    if (pulseSamples > 0 && s % pulseSamples == 0)
                    {
                        const auto k = (int) (s / pulseSamples);
                        if (k < meterNum) click.trigger (k == 0 ? 783.99 : 523.25, k == 0 ? 1.0f : 0.6f, i);
                    }
                }
                countInSamples += w;
            }
            waitSamples -= w;
            done = w;
        }
        while (done < n)
        {
            const double secStart = tempo.secAt (position);
            double endBeat = tempo.beatAt (secStart + (double) (n - done) / rate);
            int segment = n - done;
            bool wrap = false;
            if (cycleOn && cycleEnd > cycleStart && position < cycleEnd - 1e-9 && endBeat >= cycleEnd - 1e-9)
            {
                segment = (int) std::llround (tempo.secBetween (position, cycleEnd) * rate);
                segment = jlimit (0, n - done, segment);
                endBeat = cycleEnd;
                wrap = true;
            }
            queue (position, endBeat, done, secStart);
            position = endBeat;
            done += segment;
            if (wrap) position = cycleStart;
            if (segment == 0 && ! wrap) break;
        }
    }

    void queue (double from, double to, int baseOffset, double secFrom)
    {
        const auto offsetOf = [&] (double beat) { return baseOffset + (int) std::llround ((tempo.secAt (beat) - secFrom) * rate); };
        for (auto& t : tracks)
        {
            if (! t->instrument || ! t->notes) continue;
            const auto& notes = *t->notes;
            auto it = std::lower_bound (notes.begin(), notes.end(), from - 1e-9, [] (const SongNote& a, double b) { return a.beat < b; });
            for (; it != notes.end() && it->beat < to - 1e-9; ++it)
            {
                const auto dur = (int64) std::llround (tempo.secBetween (it->beat, it->beat + it->lengthBeats) * rate);
                t->instrument->noteOn ({ jmax (0, offsetOf (it->beat)), it->midi, it->velocity, std::max<int64> (1, dur) });
            }
        }
        if (metronome)
        {
            // A click on every pulse, accented on the downbeat (and each group in compound meters).
            const double first = std::ceil (from / meterPulse - 1e-9) * meterPulse;
            for (double b = first; b < to - 1e-9; b += meterPulse)
            {
                const int pulse = (int) std::llround (b / meterPulse) % meterNum;
                const bool down = pulse == 0, group = meterCompound && pulse % 3 == 0;
                click.trigger (down ? 783.99 : 523.25, down ? 1.0f : group ? 0.75f : 0.45f, jmax (0, offsetOf (b)));
            }
        }
    }

    static TrackSettings parseSettings (const var& t)
    {
        TrackSettings s;
        auto num = [&] (const var& o, const char* k, float def) { return o.hasProperty (k) ? (float) (double) o[k] : def; };
        s.eqLow = num (t, "eqLow", 0); s.eqMid = num (t, "eqMid", 0); s.eqHigh = num (t, "eqHigh", 0);
        s.tone = num (t, "tone", 1); s.drive = num (t, "drive", 0); s.volumeDb = num (t, "volume", -4);
        s.pan = num (t, "pan", 0); s.reverb = num (t, "reverb", 0); s.echo = num (t, "echo", 0);
        s.mute = (bool) t.getProperty ("mute", false);
        return s;
    }

    static std::shared_ptr<const std::vector<SongNote>> parseNotes (const var& v)
    {
        auto notes = std::make_shared<std::vector<SongNote>>();
        if (auto* a = v.getArray())
            for (auto& n : *a)
                if (auto* x = n.getArray(); x != nullptr && x->size() >= 4)
                    notes->push_back ({ (double) (*x)[0], (double) (*x)[1], (int) (*x)[2], (float) (double) (*x)[3] });
        std::stable_sort (notes->begin(), notes->end(), [] (auto& a, auto& b) { return a.beat < b.beat; });
        return notes;
    }

    std::unique_ptr<Instrument> buildInstrument (const var& d)
    {
        const String kind = d["kind"];
        if (kind == "sampler")
        {
            std::map<int, std::shared_ptr<Sample>> zones;
            if (auto* o = d["zones"].getDynamicObject())
                for (auto& p : o->getProperties())
                    if (auto s = pool.get (p.value.toString())) zones[p.name.toString().getIntValue()] = s;
            return std::make_unique<SamplerInstrument> (std::move (zones), (double) d.getProperty ("attack", 0.0), (double) d.getProperty ("release", 0.5),
                                                        d.getProperty ("curve", "exponential").toString() != "linear", (float) (double) d.getProperty ("volume", 0.0));
        }
        if (kind == "kit")
        {
            std::map<int, std::vector<std::shared_ptr<Sample>>> pieces;
            if (auto* o = d["pieces"].getDynamicObject())
                for (auto& p : o->getProperties())
                    if (auto* layers = p.value.getArray())
                        for (auto& id : *layers)
                            if (auto s = pool.get (id.toString())) pieces[p.name.toString().getIntValue()].push_back (s);
            return std::make_unique<KitInstrument> (std::move (pieces), (float) (double) d.getProperty ("volume", 0.0));
        }
        return nullptr;
    }
};

} // namespace bb
