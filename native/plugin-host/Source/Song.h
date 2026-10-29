// The native song engine: plays a whole song (tempo map, cycle, every track's instrument through its
// mixer chain, sends and master) in the helper. It mirrors src/engine/engine.js scheduleProject() and
// the instrument classes in instruments.js, so songs sound the same as in the app's own engine.
//
// The app sends the song as JSON (song:set) and the decoded sample data its instruments use (binary
// 'S' frames, at the song's sample rate), so both engines play identical samples.

#pragma once

#include "Dsp.h"
#include "Synth.h"
#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <functional>

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

// instruments.js ToneInstrument: a sound source, then its effects, then the output level.
class ChainedInstrument : public Instrument
{
public:
    std::vector<var> effectSpecs;
    float outputGain = 1;

    void prepare (double sampleRate, int maxBlock) override
    {
        rate = sampleRate;
        tmpL.assign ((size_t) maxBlock, 0.0f);
        tmpR.assign ((size_t) maxBlock, 0.0f);
        effects.clear();
        for (auto& e : effectSpecs)
            if (auto fx = makeEffect (e, rate, maxBlock)) effects.push_back (std::move (fx));
        prepareSource();
    }

    void render (float* L, float* R, int n) override
    {
        FloatVectorOperations::clear (tmpL.data(), n);
        FloatVectorOperations::clear (tmpR.data(), n);
        renderSource (tmpL.data(), tmpR.data(), n);
        for (auto& e : effects) e->process (tmpL.data(), tmpR.data(), n);
        for (int i = 0; i < n; ++i) { L[i] += tmpL[(size_t) i] * outputGain; R[i] += tmpR[(size_t) i] * outputGain; }
    }

protected:
    double rate = 48000;
    virtual void prepareSource() {}
    virtual void renderSource (float* L, float* R, int n) = 0;

private:
    std::vector<float> tmpL, tmpR;
    std::vector<std::unique_ptr<Effect>> effects;
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
class SamplerInstrument final : public ChainedInstrument
{
public:
    SamplerInstrument (std::map<int, std::shared_ptr<Sample>> zonesIn, double attackSec, double releaseSec, bool expCurve)
        : zones (std::move (zonesIn)), attack (attackSec), release (releaseSec), exponential (expCurve) {}

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
        v.gain = 1;
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

protected:
    void renderSource (float* L, float* R, int n) override { pool.render (L, R, n); }

private:
    std::map<int, std::shared_ptr<Sample>> zones;
    double attack, release;
    bool exponential;
    VoicePool pool;
};

//==============================================================================
// instruments.js DrumKit: one-shots with velocity layers, a 40 ms linear fade at the end, and closed
// hats choking the open hat.
class KitInstrument final : public ChainedInstrument
{
public:
    explicit KitInstrument (std::map<int, std::vector<std::shared_ptr<Sample>>> piecesIn) : pieces (std::move (piecesIn)) {}

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
        v.gain = 1;
        const float g = count > 1 ? 0.55f + 0.45f * e.velocity : 0.15f + 0.85f * e.velocity;
        v.env.start (g, 0, 0.04, rate, false);
        v.endAt = (int64) std::llround (sample->data.getNumSamples() / v.step);
    }

    void noteOff (int, int) override {}
    void allNotesOff (int offset) override { for (auto& v : pool.voices) if (v.active && v.midi == 46) v.env.stop (offset - v.delay); }

protected:
    void renderSource (float* L, float* R, int n) override { pool.render (L, R, n); }

private:
    std::map<int, std::vector<std::shared_ptr<Sample>>> pieces;
    VoicePool pool;
};

//==============================================================================
// multisampler.js MultiSampler: SoundFont/SFZ/folder instruments. Regions arrive as the app's loader
// normalised them (keys, velocities, conditions, envelopes, loops, filters), each with its sample.
class MultiSamplerInstrument final : public ChainedInstrument
{
public:
    MultiSamplerInstrument (const var& d, SamplePool& pool)
    {
        if (auto* arr = d["regions"].getArray())
            for (auto& rv : *arr)
                if (auto s = pool.get (rv["sample"].toString()))
                {
                    Region r;
                    r.sample = s;
                    r.lokey = rv.getProperty ("lokey", 0); r.hikey = rv.getProperty ("hikey", 127);
                    r.lovel = rv.getProperty ("lovel", 1); r.hivel = rv.getProperty ("hivel", 127);
                    if (auto* cs = rv["conds"].getArray()) for (auto& c : *cs) r.conds.push_back ({ (int) c["cc"], (int) c["lo"], (int) c["hi"] });
                    r.swLast = rv["swLast"].isVoid() ? -1 : (int) rv["swLast"];
                    r.swDown = rv["swDown"].isVoid() ? -1 : (int) rv["swDown"];
                    if (auto* sw = rv["swRange"].getArray(); sw != nullptr && sw->size() == 2)
                        for (int k = (int) (*sw)[0]; k <= (int) (*sw)[1]; ++k) swKeys.insert (k);
                    r.trigger = rv.getProperty ("trigger", "attack").toString();
                    r.seqLength = rv.getProperty ("seqLength", 1); r.seqPosition = rv.getProperty ("seqPosition", 1);
                    r.lorand = rv.getProperty ("lorand", 0.0); r.hirand = rv.getProperty ("hirand", 1.0);
                    r.group = rv.getProperty ("group", 0); r.offBy = rv.getProperty ("offBy", 0);
                    r.root = rv.getProperty ("root", 60); r.keytrack = rv.getProperty ("keytrack", 1.0); r.tune = rv.getProperty ("tune", 0.0);
                    const String mode = rv.getProperty ("loopMode", "none").toString();
                    r.loopMode = mode;
                    r.loopStart = rv.getProperty ("loopStart", 0.0); r.loopEnd = rv.getProperty ("loopEnd", 0.0);
                    r.offset = rv.getProperty ("offset", 0.0); r.offsetRandom = rv.getProperty ("offsetRandom", 0.0);
                    r.end = rv["end"].isVoid() ? -1.0 : (double) rv["end"];
                    r.gainDb = rv.getProperty ("gainDb", 0.0); r.pan = rv.getProperty ("pan", 0.0); r.veltrack = rv.getProperty ("veltrack", 1.0);
                    if (auto* vc = rv["velcurve"].getArray()) for (auto& p : *vc) if (auto* xy = p.getArray()) r.velcurve.push_back ({ (double) (*xy)[0], (double) (*xy)[1] });
                    r.env = parseEnv (rv["env"]);
                    const var f = rv["filter"];
                    if (f.isObject())
                    {
                        r.hasFilter = true;
                        r.filterType = ToneFilter::parseType (f.getProperty ("type", "lowpass").toString());
                        r.cutoff = f.getProperty ("cutoff", 20000.0); r.resonance = f.getProperty ("resonance", 0.0);
                        r.filterKeytrack = f.getProperty ("keytrack", 0.0); r.keycenter = f.getProperty ("keycenter", 60.0);
                        r.filterVeltrack = f.getProperty ("veltrack", 0.0); r.egDepth = f.getProperty ("egDepth", 0.0);
                        r.filterEnv = parseEnv (f["eg"]);
                    }
                    regions.push_back (std::move (r));
                }
        lastSwitch = d["initialSwitch"].isVoid() ? -1 : (int) d["initialSwitch"];
        if (auto* o = d["cc"].getDynamicObject())
            for (auto& p : o->getProperties()) cc[p.name.toString().getIntValue()] = (int) p.value;
    }

    void noteOn (const NoteEvent& e) override { events.push_back ({ now + e.offset, true, e.midi, e.velocity, e.durationSamples }); }
    void noteOff (int midi, int offset) override { events.push_back ({ now + offset, false, midi, 0, -1 }); }
    void allNotesOff (int offset) override
    {
        for (auto& v : voices) if (v.active) stopVoice (v, now + offset, minRelease, true);
        held.clear(); live.clear();
    }

protected:
    void renderSource (float* L, float* R, int n) override
    {
        std::stable_sort (events.begin(), events.end(), [] (auto& a, auto& b) { return a.at < b.at; });
        for (auto& e : events)
        {
            if (e.at >= now + n) continue;
            if (e.on) start (e);
            else release (e.midi, e.at);
            e.at = -1;
        }
        events.erase (std::remove_if (events.begin(), events.end(), [] (auto& e) { return e.at < 0; }), events.end());
        for (auto& v : voices) if (v.active) renderVoice (v, L, R, n);
        now += n;
    }

private:
    struct Env { double delay = 0, attack = 0, hold = 0, decay = 0, sustain = 1, release = 0.05; };
    struct Cond { int cc, lo, hi; };
    struct Region
    {
        std::shared_ptr<Sample> sample;
        int lokey = 0, hikey = 127, lovel = 1, hivel = 127, swLast = -1, swDown = -1, seqLength = 1, seqPosition = 1, group = 0, offBy = 0;
        std::vector<Cond> conds;
        String trigger = "attack", loopMode = "none";
        double lorand = 0, hirand = 1, root = 60, keytrack = 1, tune = 0, loopStart = 0, loopEnd = 0, offset = 0, offsetRandom = 0, end = -1;
        double gainDb = 0, pan = 0, veltrack = 1;
        std::vector<std::pair<double, double>> velcurve;
        Env env;
        bool hasFilter = false;
        Biquad::Type filterType = Biquad::lowpass;
        double cutoff = 20000, resonance = 0, filterKeytrack = 0, keycenter = 60, filterVeltrack = 0, egDepth = 0;
        Env filterEnv;
        int seq = 0;
    };

    // A Web Audio param following the DAHDS envelope, then a setTargetAtTime release.
    struct ParamEnv
    {
        Env e; double base = 0, depth = 1, rate = 48000;
        int64 t = 0, releaseAt = -1; double tau = 0, releasedFrom = 0;
        double value() const
        {
            const double s = (double) t / rate;
            if (releaseAt >= 0 && t >= releaseAt)
            {
                const double rs = (double) (t - releaseAt) / rate;
                return base + (releasedFrom - base) * std::exp (-rs / jmax (1e-6, tau));
            }
            return dahds (s);
        }
        double dahds (double s) const
        {
            const double tA = e.delay, tD = tA + e.attack + e.hold;
            if (s < tA) return base;
            if (s < tA + e.attack) return e.attack > 0.0005 ? base + depth * (s - tA) / e.attack : base + depth;
            if (s < tD || e.sustain >= 1) return base + depth;
            const double target = base + depth * e.sustain;
            if (e.decay <= 0.0005) return target;
            return target + (base + depth - target) * std::exp (-(s - tD) / (e.decay / 4));
        }
        // cancelAndHold at the release moment, then approach the base with time constant `tc`.
        void release (int64 at, double tc) { if (releaseAt >= 0 && at >= releaseAt) return; const auto saved = t; t = at; releasedFrom = value(); t = saved; releaseAt = at; tau = tc; }
    };

    struct Voice
    {
        const Region* region = nullptr;
        double pos = 0, step = 1;
        int64 startAt = 0, endAt = 0;      // absolute samples
        ParamEnv amp, cutoffCents;
        Biquad fl, fr;
        double filterFreq = 0;
        bool active = false, released = false, oneShot = false;
        int midi = -1;
        float panX = 0.5f;
    };

    struct Event { int64 at; bool on; int midi; float velocity; int64 duration; };

    std::vector<Region> regions;
    std::vector<Voice> voices = std::vector<Voice> (96);
    std::vector<Event> events;
    std::set<int> swKeys;
    std::map<int, int> cc;
    std::map<int, float> held;
    std::map<int, std::vector<Voice*>> live;
    int lastSwitch = -1;
    int64 now = 0;
    Random random;
    static constexpr double minRelease = 0.006;

    static Env parseEnv (const var& o)
    {
        Env e;
        if (! o.isObject()) return e;
        e.delay = o.getProperty ("delay", 0.0); e.attack = o.getProperty ("attack", 0.0); e.hold = o.getProperty ("hold", 0.0);
        e.decay = o.getProperty ("decay", 0.0); e.sustain = o.getProperty ("sustain", 1.0); e.release = o.getProperty ("release", 0.05);
        return e;
    }

    bool matches (const Region& r, int midi, int v127) const
    {
        if (midi < r.lokey || midi > r.hikey || v127 < r.lovel || v127 > r.hivel) return false;
        for (auto& c : r.conds) { auto it = cc.find (c.cc); const int value = it == cc.end() ? 0 : it->second; if (value < c.lo || value > c.hi) return false; }
        if (r.swLast >= 0 && r.swLast != lastSwitch) return false;
        if (r.swDown >= 0 && ! held.count (r.swDown)) return false;
        return true;
    }

    double velocityGain (const Region& r, int v127) const
    {
        if (! r.velcurve.empty())
        {
            std::vector<std::pair<double, double>> pts { { 0, 0 } };
            pts.insert (pts.end(), r.velcurve.begin(), r.velcurve.end());
            if (std::none_of (r.velcurve.begin(), r.velcurve.end(), [] (auto& p) { return p.first == 127; })) pts.push_back ({ 127, 1 });
            for (size_t i = 1; i < pts.size(); ++i)
                if (v127 <= pts[i].first)
                    return pts[i - 1].second + (pts[i].second - pts[i - 1].second) * ((v127 - pts[i - 1].first) / jmax (1.0, pts[i].first - pts[i - 1].first));
            return pts.back().second;
        }
        const double x = v127 / 127.0;
        return 1 - r.veltrack + r.veltrack * x * x;
    }

    void start (const Event& e)
    {
        const bool isLive = e.duration < 0;
        if (isLive) held[e.midi] = e.velocity;
        if (swKeys.count (e.midi)) { lastSwitch = e.midi; return; }
        const int v127 = jlimit (1, 127, (int) std::lround (e.velocity * 127));
        const int others = isLive ? (int) held.size() - 1 : 0;
        const double rnd = random.nextDouble();
        std::vector<Voice*> started;
        for (auto& r : regions)
        {
            if (r.trigger == "release" || ! matches (r, e.midi, v127)) continue;
            const int n = ++r.seq;
            if (r.seqLength > 1 && ((n - 1) % r.seqLength) + 1 != r.seqPosition) continue;
            if (rnd < r.lorand || rnd >= r.hirand) continue;
            if (r.trigger == "first" && others > 0) continue;
            if (r.trigger == "legato" && others == 0) continue;
            if (r.group != 0)
                for (auto& v : voices) if (v.active && v.region->offBy == r.group && v.endAt > e.at) stopVoice (v, e.at, minRelease, true);
            started.push_back (startVoice (r, e.midi, v127, e.at));
        }
        if (isLive) live[e.midi] = started;
        else
        {
            // A scheduled note releases itself after its length.
            const auto at = e.at + e.duration;
            for (auto* v : started) if (! v->oneShot) stopVoice (*v, at, v->region->env.release, false);
            releaseTriggers (e.midi, at, v127);
        }
    }

    void release (int midi, int64 at)
    {
        auto it = held.find (midi);
        if (it == held.end()) return;
        const int v127 = jlimit (1, 127, (int) std::lround (it->second * 127));
        held.erase (it);
        for (auto* v : live[midi]) if (v->active && ! v->oneShot) stopVoice (*v, at, v->region->env.release, false);
        live.erase (midi);
        releaseTriggers (midi, at, v127);
    }

    void releaseTriggers (int midi, int64 at, int v127)
    {
        if (swKeys.count (midi)) return;
        for (auto& r : regions)
            if (r.trigger == "release" && matches (r, midi, v127)) startVoice (r, midi, v127, at);
    }

    Voice* startVoice (const Region& r, int midi, int v127, int64 at)
    {
        Voice* v = nullptr;
        for (auto& x : voices) if (! x.active || x.endAt <= at) { v = &x; break; }
        if (v == nullptr)
        {
            v = &*std::min_element (voices.begin(), voices.end(), [] (auto& a, auto& b) { return a.startAt < b.startAt; });
        }
        *v = Voice();
        v->region = &r;
        v->active = true;
        v->midi = midi;
        v->startAt = at;
        const auto& d = r.sample->data;
        v->step = std::pow (2.0, ((midi - r.root) * r.keytrack * 100 + r.tune) / 1200.0) * r.sample->rate / rate;
        const double offset = jmin (d.getNumSamples() / r.sample->rate - 0.001, r.offset + (r.offsetRandom > 0 ? random.nextDouble() * r.offsetRandom : 0.0));
        v->pos = offset * r.sample->rate;
        const bool looping = (r.loopMode == "continuous" || r.loopMode == "sustain") && r.loopEnd > r.loopStart;
        const double playable = r.end >= 0 ? jmax (0.001, r.end - offset) : (d.getNumSamples() / r.sample->rate - offset);
        const double playbackRate = v->step * rate / r.sample->rate;
        v->endAt = looping ? std::numeric_limits<int64>::max() : at + (int64) std::llround (playable / playbackRate * rate);
        v->oneShot = r.loopMode == "one_shot";
        v->amp.e = r.env; v->amp.rate = rate; v->amp.base = 0;
        v->amp.depth = std::pow (10.0, r.gainDb / 20) * velocityGain (r, v127);
        if (r.hasFilter)
        {
            const double cents = r.filterKeytrack * (midi - r.keycenter) + r.filterVeltrack * (v127 / 127.0);
            v->filterFreq = jlimit (10.0, rate / 2 - 100, r.cutoff * std::pow (2.0, cents / 1200));
            v->cutoffCents.e = r.filterEnv; v->cutoffCents.rate = rate; v->cutoffCents.base = 0; v->cutoffCents.depth = r.egDepth;
        }
        // Chromium's StereoPannerNode treats these voices as stereo even for mono samples (L = R): at
        // the centre both sides get the full signal, and hard left puts both on the left (+6 dB).
        // Measured against the app; the stereo formula reproduces it.
        v->panX = (float) jlimit (-1.0, 1.0, r.pan);
        return v;
    }

    void stopVoice (Voice& v, int64 at, double rel, bool force)
    {
        if (! v.active || (v.released && ! force)) return;
        v.released = true;
        const int64 t = jmax (at, v.startAt) - v.startAt;
        const double r = jmax (minRelease, rel);
        v.amp.release (t, r / 5);
        if (v.region->hasFilter && v.region->egDepth != 0) v.cutoffCents.release (t, jmax (minRelease, v.region->filterEnv.release) / 5);
        const int64 end = at + (int64) std::llround ((r + 0.02) * rate);
        if (end < v.endAt) v.endAt = end;
    }

    void renderVoice (Voice& v, float* L, float* R, int n)
    {
        const auto& r = *v.region;
        const auto& d = r.sample->data;
        const int len = d.getNumSamples();
        const float* sl = d.getReadPointer (0);
        const float* sr = d.getNumChannels() > 1 ? d.getReadPointer (1) : sl;
        const bool looping = (r.loopMode == "continuous" || r.loopMode == "sustain") && r.loopEnd > r.loopStart;
        const double ls = r.loopStart * r.sample->rate, le = r.loopEnd * r.sample->rate;
        for (int i = 0; i < n; ++i)
        {
            const int64 abs = now + i;
            if (abs < v.startAt) continue;
            if (abs >= v.endAt) { v.active = false; return; }
            const int k = (int) v.pos;
            if (k + 1 >= len && ! looping) { v.active = false; return; }
            const float f = (float) (v.pos - k);
            float a = sl[k] + (sl[jmin (k + 1, len - 1)] - sl[k]) * f;
            float b = sr[k] + (sr[jmin (k + 1, len - 1)] - sr[k]) * f;
            v.amp.t = abs - v.startAt;
            const float g = (float) v.amp.value();
            a *= g; b *= g;
            if (r.hasFilter)
            {
                v.cutoffCents.t = v.amp.t;
                const double freq = jlimit (10.0, rate / 2 - 100, v.filterFreq * std::pow (2.0, v.cutoffCents.value() / 1200));
                const double q = r.filterType == Biquad::lowpass || r.filterType == Biquad::highpass ? r.resonance : jmax (0.1, std::pow (10.0, r.resonance / 20));
                if ((i & 15) == 0) { v.fl.set (r.filterType, freq, q, 0, rate); v.fr.set (r.filterType, freq, q, 0, rate); }
                a = v.fl.process (a); b = v.fr.process (b);
            }
            const double p = v.panX;
            if (p <= 0) { const double x = p + 1; L[i] += a + b * (float) std::cos (x * MathConstants<double>::halfPi); R[i] += b * (float) std::sin (x * MathConstants<double>::halfPi); }
            else { L[i] += a * (float) std::cos (p * MathConstants<double>::halfPi); R[i] += b + a * (float) std::sin (p * MathConstants<double>::halfPi); }
            v.pos += v.step;
            if (looping && v.pos >= le) v.pos = ls + std::fmod (v.pos - ls, le - ls);
        }
    }
};

//==============================================================================
// instruments.js makeSynthKit(): the Electro kit, drums synthesised by note number.
class SynthKitInstrument final : public ChainedInstrument
{
public:
    explicit SynthKitInstrument (var partsIn) : parts (std::move (partsIn)) {}

    void noteOn (const NoteEvent& e) override { events.push_back ({ now + e.offset, e.midi, e.velocity }); }
    void noteOff (int, int) override {}
    void allNotesOff (int) override {}

protected:
    void prepareSource() override
    {
        kick.setup (part ("kick"), rate);
        snareBody.setup (part ("snareBody"), rate);
        tom.setup (part ("tom"), rate);
        snareNoise.setup (part ("snareNoise"), part ("snareFilter"), rate);
        clap.setup (part ("clap"), part ("clapFilter"), rate);
        hat.setup (part ("hat"), rate);
        openHat.setup (part ("openHat"), rate);
        crash.setup (part ("crash"), rate);
    }

    void renderSource (float* L, float* R, int n) override
    {
        int pos = 0;
        std::stable_sort (events.begin(), events.end(), [] (auto& a, auto& b) { return a.at < b.at; });
        while (pos < n)
        {
            size_t k = 0;
            for (; k < events.size() && events[k].at <= now + pos; ++k) play (events[k].midi, events[k].velocity);
            events.erase (events.begin(), events.begin() + (long) k);
            const int next = events.empty() ? n : (int) jlimit<int64> (pos + 1, n, events.front().at - now);
            const int len = next - pos;
            kick.render (L + pos, R + pos, len); snareBody.render (L + pos, R + pos, len); tom.render (L + pos, R + pos, len);
            snareNoise.render (L + pos, R + pos, len); clap.render (L + pos, R + pos, len);
            hat.render (L + pos, R + pos, len); openHat.render (L + pos, R + pos, len); crash.render (L + pos, R + pos, len);
            pos = next;
        }
        now += n;
    }

private:
    struct Event { int64 at; int midi; float velocity; };
    var parts;
    std::vector<Event> events;
    int64 now = 0;
    MembraneVoice kick, snareBody, tom;
    NoiseVoice snareNoise, clap;
    MetalVoice hat, openHat, crash;

    var part (const char* name) const { return parts[name]; }
    int64 secs (double s) const { return (int64) std::llround (s * rate); }
    static double hz (int midi) { return 440.0 * std::pow (2.0, (midi - 69) / 12.0); }

    void play (int midi, float v)
    {
        switch (midi)
        {
            case 35: case 36: kick.trigger (hz (24), v, secs (0.3)); break;
            case 37: case 38: case 40: snareNoise.trigger (v, secs (0.15)); snareBody.trigger (hz (43), v * 0.8, secs (0.1)); break;
            case 39: clap.trigger (v, secs (0.2)); break;
            case 42: case 44: openHat.release(); hat.trigger (400, v, secs (0.05)); break;
            case 46: openHat.trigger (400, v, secs (0.35)); break;
            case 41: case 43: tom.trigger (hz (33), v, secs (0.3)); break;
            case 45: case 47: tom.trigger (hz (38), v, secs (0.3)); break;
            case 48: case 50: tom.trigger (hz (43), v, secs (0.3)); break;
            case 49: case 51: case 55: case 57: crash.trigger (300, v * 0.8, secs (1)); break;
            default: hat.trigger (600, v * 0.6, secs (0.03));
        }
    }
};

//==============================================================================
// Tone.PolySynth of Synth / MonoSynth / FMSynth voices. A note gets a free voice (one whose release
// has finished) or a new one up to maxPolyphony; releasing a note releases its sounding voice.
class PolySynthInstrument final : public ChainedInstrument
{
public:
    PolySynthInstrument (SynthVoice::Settings s, int maxVoices, float volumeDb)
        : settings (std::move (s)), maxPolyphony (jmax (1, maxVoices)), volume (Decibels::decibelsToGain (volumeDb)) {}

    void noteOn (const NoteEvent& e) override
    {
        events.push_back ({ now + e.offset, true, e.midi, e.velocity });
        if (e.durationSamples >= 0) events.push_back ({ now + e.offset + e.durationSamples, false, e.midi, 0 });
    }

    void noteOff (int midi, int offset) override { events.push_back ({ now + offset, false, midi, 0 }); }

    void allNotesOff (int offset) override
    {
        for (auto& v : voices) if (! v.released) events.push_back ({ now + offset, false, v.midi, 0 });
    }

protected:
    void prepareSource() override { voices.reserve ((size_t) maxPolyphony); }

    void renderSource (float* L, float* R, int n) override
    {
        mono.resize ((size_t) n);
        FloatVectorOperations::clear (mono.data(), n);
        std::stable_sort (events.begin(), events.end(), [] (auto& a, auto& b) { return a.at < b.at || (a.at == b.at && ! a.on && b.on); });
        int pos = 0;
        while (pos < n)
        {
            // Events due in this stretch, then render up to the next one.
            size_t k = 0;
            for (; k < events.size() && events[k].at <= now + pos; ++k) apply (events[k]);
            events.erase (events.begin(), events.begin() + (long) k);
            int next = n;
            if (! events.empty()) next = (int) jlimit<int64> (pos + 1, n, events.front().at - now);
            for (auto& v : voices)
                if (! v.silent()) v.render (mono.data(), pos, next);
            pos = next;
        }
        now += n;
        for (int i = 0; i < n; ++i) { const float x = mono[(size_t) i] * volume; L[i] += x; R[i] += x; }
    }

private:
    struct Event { int64 at; bool on; int midi; float velocity; };
    SynthVoice::Settings settings;
    int maxPolyphony;
    float volume;
    std::vector<SynthVoice> voices;
    std::vector<Event> events;
    std::vector<float> mono;
    int64 now = 0, counter = 0;

    void apply (const Event& e)
    {
        if (e.on)
        {
            SynthVoice* v = nullptr;
            for (auto& x : voices) if (x.silent()) { v = &x; break; }
            if (v == nullptr && (int) voices.size() < maxPolyphony) { voices.emplace_back(); v = &voices.back(); }
            if (v == nullptr) return;   // Tone drops notes beyond maxPolyphony
            v->start (settings, e.midi, e.velocity, rate);
            v->age = ++counter;
            return;
        }
        // Release the oldest sounding voice for this note.
        SynthVoice* target = nullptr;
        for (auto& x : voices)
            if (x.midi == e.midi && ! x.released && (target == nullptr || x.age < target->age)) target = &x;
        if (target) target->release();
    }
};

//==============================================================================
// A plugin the helper has loaded (see Main.cpp), driven straight from the audio thread.
struct PluginSource
{
    virtual ~PluginSource() = default;
    // Adds n samples of the plugin's output to L/R, given this block's MIDI and the song position.
    virtual void process (float* L, float* R, int n, const MidiBuffer& midi, double bpm, double ppq, bool playing) = 0;
};

using PluginResolver = std::function<std::shared_ptr<PluginSource> (int instance)>;

// Where the song is, for plugins that follow the host's tempo.
struct SongPosition { double bpm = 120, beat = 0; bool playing = false; };

class PluginTrackInstrument final : public ChainedInstrument
{
public:
    PluginTrackInstrument (std::shared_ptr<PluginSource> s, const SongPosition& p) : source (std::move (s)), position (p) {}

    void noteOn (const NoteEvent& e) override
    {
        events.push_back ({ now + e.offset, MidiMessage::noteOn (1, e.midi, (uint8) jlimit (1, 127, (int) std::lround (e.velocity * 127))) });
        if (e.durationSamples >= 0) events.push_back ({ now + e.offset + e.durationSamples, MidiMessage::noteOff (1, e.midi) });
        held.insert (e.midi);
    }

    void noteOff (int midi, int offset) override { events.push_back ({ now + offset, MidiMessage::noteOff (1, midi) }); }

    void allNotesOff (int offset) override
    {
        for (int m : held) events.push_back ({ now + offset, MidiMessage::noteOff (1, m) });
        events.push_back ({ now + offset, MidiMessage::controllerEvent (1, 64, 0) });
        events.push_back ({ now + offset, MidiMessage::allNotesOff (1) });
        held.clear();
    }

protected:
    void renderSource (float* L, float* R, int n) override
    {
        midi.clear();
        std::stable_sort (events.begin(), events.end(), [] (auto& a, auto& b) { return a.at < b.at; });
        size_t k = 0;
        for (; k < events.size() && events[k].at < now + n; ++k)
            midi.addEvent (events[k].message, (int) std::max<int64> (0, events[k].at - now));
        events.erase (events.begin(), events.begin() + (long) k);
        if (source) source->process (L, R, n, midi, position.bpm, position.beat, position.playing);
        now += n;
    }

private:
    struct Event { int64 at; MidiMessage message; };
    std::shared_ptr<PluginSource> source;
    const SongPosition& position;
    std::vector<Event> events;
    std::set<int> held;
    MidiBuffer midi;
    int64 now = 0;
};

//==============================================================================
// A track: its notes, instrument and mixer chain.
struct SongNote { double beat, lengthBeats; int midi; float velocity; };

// One pass of an audio clip (engine.js audioSegments()): plays from `offset` seconds into the
// (already time-stretched) audio for `seconds`, starting at `beat`; `spb` converts beats into it.
struct ClipSegment
{
    double beat, lengthBeats;
    std::shared_ptr<Sample> sample;
    double offset, seconds, spb;
    float gain;
};

class TrackPlayer
{
public:
    String id;
    std::unique_ptr<Instrument> instrument;
    String instrumentKey;                  // rebuild the instrument when this changes
    std::shared_ptr<const std::vector<SongNote>> notes;   // sorted by beat
    std::shared_ptr<const std::vector<ClipSegment>> clips;  // sorted by beat
    VoicePool clipVoices;
    double rate = 48000;

    // Starts a clip segment `skipSeconds` in, at `offset` in the block (Tone.ToneBufferSource:
    // linear 3 ms fade in, or 5 ms when starting partway; 10 ms fade out after its length).
    void startClip (const ClipSegment& c, double skipSeconds, int offset)
    {
        if (skipSeconds >= c.seconds - 0.001) return;
        auto& v = clipVoices.take();
        v.sample = c.sample;
        v.step = c.sample->rate / rate;
        v.pos = (c.offset + skipSeconds) * c.sample->rate;
        v.delay = offset;
        v.midi = -1;
        v.gain = 1;
        v.env.start (c.gain, skipSeconds > 0 ? 0.005 : 0.003, 0.01, rate, false);
        v.env.stop ((int64) std::llround ((c.seconds - skipSeconds) * rate));
        v.endAt = -1;
    }

    void stopClips (int offset) { for (auto& v : clipVoices.voices) if (v.active) v.env.stop (offset - v.delay); }
    TrackChain chain;
    TrackSettings settings;
    const AudioBuffer<float>* ir = nullptr;
    bool settingsChanged = true;
    float peak = 0;

    void prepare (double sampleRate, int block)
    {
        rate = sampleRate;
        chain.prepare (rate, block);
        if (instrument) instrument->prepare (rate, block);
        mixL.setSize (1, block); mixR.setSize (1, block); mono.setSize (1, block); scratchR.setSize (1, block);
        settingsChanged = true;
    }

    // Renders the instrument and runs the chain, adding to out and the send buses.
    void render (int n, float* outL, float* outR, float* revL, float* revR, float* echoL, float* echoR)
    {
        if (settingsChanged) { chain.configure (settings, ir); settingsChanged = false; }
        auto* l = mixL.getWritePointer (0);
        auto* r = mixR.getWritePointer (0);
        auto* m = mono.getWritePointer (0);
        FloatVectorOperations::clear (l, n);
        FloatVectorOperations::clear (r, n);
        if (instrument) instrument->render (l, r, n);
        clipVoices.render (l, r, n);
        // The chain runs in stereo and outputs the panned channel (the meter reads it, post fader).
        FloatVectorOperations::copy (m, l, n);
        FloatVectorOperations::clear (l, n);
        auto* rin = scratchR.getWritePointer (0);
        FloatVectorOperations::copy (rin, r, n);
        FloatVectorOperations::clear (r, n);
        chain.process (m, rin, n, l, r, revL, revR, echoL, echoR);
        float pk = peak;
        for (int i = 0; i < n; ++i) { outL[i] += l[i]; outR[i] += r[i]; pk = jmax (pk, std::abs (l[i]), std::abs (r[i])); }
        peak = pk;
    }

private:
    AudioBuffer<float> mixL, mixR, mono, scratchR;
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

    // How plugin tracks find the plugin instances the helper has loaded.
    PluginResolver plugins;
    // Cabinet impulse responses by path (decoded by the helper).
    std::function<const AudioBuffer<float>* (const String&)> irs;

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
        struct Change { std::shared_ptr<TrackPlayer> track; std::unique_ptr<Instrument> instrument; String key; bool newInstrument; TrackSettings settings; std::shared_ptr<const std::vector<SongNote>> notes; std::shared_ptr<const std::vector<ClipSegment>> clips; const AudioBuffer<float>* ir = nullptr; };
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
                Change c { track, nullptr, {}, false, parseTrackSettings (tv), parseNotes (tv["notes"]), parseClips (tv["clips"]) };
                c.ir = c.settings.amp.cab == "ir" && irs ? irs (c.settings.amp.irPath) : nullptr;
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
            c.track->clips = c.clips;
            c.track->ir = c.ir;
        }
        cycleOn = (bool) song["cycle"].getProperty ("on", false);
        cycleStart = (double) song["cycle"].getProperty ("start", 0.0);
        cycleEnd = (double) song["cycle"].getProperty ("end", 4.0);
        masterDb = (float) (double) song.getProperty ("masterVolume", 0.0);
        masterFx = song["masterFx"];
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
        resumeClips = true;   // clips already under way at `beat` pick up partway
        waitSamples = std::max<int64> (0, delaySamples);
        countInClicks = countIn;
        countInSamples = 0;
        playing = true;
    }

    void stop()
    {
        const ScopedLock l (lock);
        playing = false;
        for (auto& t : tracks) { if (t->instrument) t->instrument->allNotesOff (0); t->stopClips (0); }
    }

    void seek (double beat)
    {
        const ScopedLock l (lock);
        position = beat;
        for (auto& t : tracks) t->stopClips (0);
        resumeClips = true;
    }

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
        if (masterChanged) { master.setVolumeDb (masterDb); master.fx.configure (masterFx); masterChanged = false; }
        const bool running = playing || offlineRender;
        master.fx.setRunning (running);
        for (auto& t : tracks) t->chain.setRunning (running);
        auto* outL = bus.getWritePointer (0); auto* outR = bus.getWritePointer (1);
        auto* revL = bus.getWritePointer (2); auto* revR = bus.getWritePointer (3);
        auto* echoL = bus.getWritePointer (4); auto* echoR = bus.getWritePointer (5);
        bus.clear (0, n);

        applyLiveNotes();
        songPosition = { tempo.bpmAt (position), position, playing && waitSamples == 0 };
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
        offlineRender = true;   // an export keeps the effects' noise running to the end, as the app's does
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

    bool resumeClips = false;
    bool playing = false, countInClicks = false, cycleOn = false, metronome = false, meterCompound = false, masterChanged = true;
    double position = 0, cycleStart = 0, cycleEnd = 4, meterPulse = 1;
    int meterNum = 4;
    float masterDb = 0;
    var masterFx;
    bool offlineRender = false;
    int64 waitSamples = 0, countInSamples = 0;
    std::atomic<double> beatNow { 0 };
    std::atomic<bool> playingNow { false };
    std::atomic<float> masterPeak { 0 };
    SongPosition songPosition;

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
            if (resumeClips) { resumeClipsAt (position, done); resumeClips = false; }
            queue (position, endBeat, done, secStart);
            position = endBeat;
            done += segment;
            if (wrap)
            {
                // Back to the cycle start: what was playing stops (with its short fade) and clips that
                // span the start resume partway, as on the app's cycle repeats.
                position = cycleStart;
                for (auto& t : tracks) t->stopClips (jmin (done, n - 1));
                resumeClips = true;
            }
            if (segment == 0 && ! wrap) break;
        }
    }

    // Clips already under way at `beat` start partway through.
    void resumeClipsAt (double beat, int offset)
    {
        for (auto& t : tracks)
            if (t->clips)
                for (auto& c : *t->clips)
                    if (c.beat < beat - 1e-9 && c.beat + c.lengthBeats > beat + 1e-9) t->startClip (c, (beat - c.beat) * c.spb, offset);
    }

    void queue (double from, double to, int baseOffset, double secFrom)
    {
        const auto offsetOf = [&] (double beat) { return baseOffset + (int) std::llround ((tempo.secAt (beat) - secFrom) * rate); };
        for (auto& t : tracks)
            if (t->clips)
                for (auto& c : *t->clips)
                    if (c.beat >= from - 1e-9 && c.beat < to - 1e-9) t->startClip (c, 0, jmax (0, offsetOf (c.beat)));
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


    std::shared_ptr<const std::vector<ClipSegment>> parseClips (const var& v)
    {
        auto clips = std::make_shared<std::vector<ClipSegment>>();
        if (auto* a = v.getArray())
            for (auto& c : *a)
                if (auto s = pool.get (c["sample"].toString()))
                    clips->push_back ({ (double) c["beat"], (double) c["length"], s, (double) c["offset"], (double) c["seconds"], (double) c["spb"], (float) (double) c.getProperty ("gain", 1.0) });
        std::stable_sort (clips->begin(), clips->end(), [] (auto& a, auto& b) { return a.beat < b.beat; });
        return clips;
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
            auto inst = std::make_unique<SamplerInstrument> (std::move (zones), (double) d.getProperty ("attack", 0.0), (double) d.getProperty ("release", 0.5),
                                                             d.getProperty ("curve", "exponential").toString() != "linear");
            return withChain (std::move (inst), d);
        }
        if (kind == "kit")
        {
            std::map<int, std::vector<std::shared_ptr<Sample>>> pieces;
            if (auto* o = d["pieces"].getDynamicObject())
                for (auto& p : o->getProperties())
                    if (auto* layers = p.value.getArray())
                        for (auto& id : *layers)
                            if (auto s = pool.get (id.toString())) pieces[p.name.toString().getIntValue()].push_back (s);
            return withChain (std::make_unique<KitInstrument> (std::move (pieces)), d);
        }
        if (kind == "plugin")
        {
            auto source = plugins ? plugins ((int) d["inst"]) : nullptr;
            if (source == nullptr) return nullptr;
            return withChain (std::make_unique<PluginTrackInstrument> (source, songPosition), d);
        }
        if (kind == "multisampler")
            return withChain (std::make_unique<MultiSamplerInstrument> (d, pool), d);
        if (kind == "synthkit")
        {
            return withChain (std::make_unique<SynthKitInstrument> (d["parts"]), d);
        }
        if (kind == "poly")
        {
            const var v = d["voice"], o = v["options"];
            SynthVoice::Settings s;
            const String type = v["type"];
            s.kind = type == "MonoSynth" ? SynthVoice::mono : type == "FMSynth" ? SynthVoice::fm : SynthVoice::plain;
            s.osc = OscSettings::parse (o["oscillator"]);
            s.env = ToneEnvelope::parse (o["envelope"]);
            s.volumeDb = (float) (double) o.getProperty ("volume", 0.0);
            s.detuneCents = (double) o.getProperty ("detune", 0.0);
            if (s.kind == SynthVoice::mono)
            {
                s.filter = o["filter"];
                const var fe = o["filterEnvelope"];
                s.filterEnv = ToneEnvelope::parse (fe);
                s.filterBase = (double) fe.getProperty ("baseFrequency", 200.0);
                s.filterOctaves = (double) fe.getProperty ("octaves", 3.0);
                s.filterExponent = (double) fe.getProperty ("exponent", 1.0);
            }
            if (s.kind == SynthVoice::fm)
            {
                s.modOsc = OscSettings::parse (o["modulation"]);
                s.modEnv = ToneEnvelope::parse (o["modulationEnvelope"]);
                s.harmonicity = (double) o.getProperty ("harmonicity", 3.0);
                s.modulationIndex = (double) o.getProperty ("modulationIndex", 10.0);
            }
            auto inst = std::make_unique<PolySynthInstrument> (std::move (s), (int) d.getProperty ("maxPolyphony", 32), (float) (double) d.getProperty ("polyVolume", 0.0));
            return withChain (std::move (inst), d);
        }
        return nullptr;
    }

    static std::unique_ptr<Instrument> withChain (std::unique_ptr<ChainedInstrument> inst, const var& d)
    {
        if (auto* fx = d["effects"].getArray())
            for (auto& e : *fx) inst->effectSpecs.push_back (e);
        inst->outputGain = Decibels::decibelsToGain ((float) (double) d.getProperty ("volume", 0.0));
        return inst;
    }
};

} // namespace bb
