// Native ports of the Tone.js synths and effects the app's instruments use (instruments.js SYNTHS
// and samplerFx/kit effects): Synth, MonoSynth and FMSynth voices in a PolySynth, and Chorus,
// Tremolo, Vibrato, FeedbackDelay, Filter and Distortion. The app sends each Tone object's resolved
// settings (its .get()), so defaults match without being copied here.

#pragma once

#include "Dsp.h"
#include <cmath>
#include <map>

namespace bb
{
using namespace juce;

//==============================================================================
// Tone's Oscillator waveforms: a PeriodicWave of partials b_n·sin(n(θ − phase)), normalised to a
// peak of 1 (as Web Audio does) and band-limited to the note's frequency.
class Wavetable
{
public:
    static constexpr int size = 4096;
    std::vector<float> table = std::vector<float> (size + 1);

    float at (double phase01) const noexcept
    {
        const double p = (phase01 - std::floor (phase01)) * size;
        const int k = (int) p;
        const float f = (float) (p - k);
        return table[(size_t) k] + (table[(size_t) k + 1] - table[(size_t) k]) * f;
    }

    // The band-limited versions of one waveform as Chromium's PeriodicWave builds them: 36 ranges a
    // third of an octave apart; range r keeps 2048·2^(−r/3) partials, and a frequency f plays a blend
    // of ranges ⌊p⌋ and ⌊p⌋+1 where p = 1 + 3·log2(f / (rate / 4096)).
    struct Set
    {
        std::vector<std::shared_ptr<const Wavetable>> tables;   // one per range
        static constexpr int ranges = 36;

        float at (double phase01, double f, double rate) const noexcept
        {
            const double lowest = rate / size;
            const double ratio = std::abs (f) > 0 ? std::abs (f) / lowest : 0.5;
            const double p = jlimit (0.0, (double) ranges - 1, 1 + std::log2 (ratio) * 3);
            const int r1 = (int) p, r2 = jmin (r1 + 1, ranges - 1);
            const float k = (float) (p - r1);
            const float a = tables[(size_t) r1]->at (phase01), b = tables[(size_t) r2]->at (phase01);
            return a + (b - a) * k;
        }
    };

    // partials[0] is the fundamental; the waveform is Σ b_n·sin(n(θ − phase)), normalised (from the
    // full-band version) to a peak of 1 as Web Audio does. Built with inverse FFTs and cached.
    static std::shared_ptr<const Set> make (const std::vector<double>& partials, double phase)
    {
        static CriticalSection cacheLock;
        static std::map<String, std::shared_ptr<const Set>> cache;
        String key;
        for (auto b : partials) key << String (b, 6) << ",";
        key << "|" << String (phase, 6);
        const ScopedLock l (cacheLock);
        if (auto it = cache.find (key); it != cache.end()) return it->second;

        const int maxN = jmin ((int) partials.size(), size / 2 - 1);
        dsp::FFT fft (12);   // 4096
        auto render = [&] (int limit) {
            // sin(nθ − np) = Re(−i·e^{−inp}·e^{inθ}): bin n holds b_n·(−sin np − i cos np), times N/2
            // so the inverse transform yields the series directly.
            std::vector<float> data ((size_t) size * 2, 0.0f);
            for (int n = 1; n <= limit; ++n)
            {
                const double b = partials[(size_t) n - 1] * size / 2.0;
                data[(size_t) n * 2] = (float) (-b * std::sin (n * phase));
                data[(size_t) n * 2 + 1] = (float) (-b * std::cos (n * phase));
            }
            fft.performRealOnlyInverseTransform (data.data());
            std::vector<float> x ((size_t) size);
            for (int i = 0; i < size; ++i) x[(size_t) i] = data[(size_t) i] * (float) size;   // JUCE scales the inverse by 1/N
            return x;
        };
        const auto full = render (maxN);
        float peak = 0;
        for (auto v : full) peak = jmax (peak, std::abs (v));
        const float scale = peak > 0 ? 1.0f / peak : 1.0f;
        auto set = std::make_shared<Set>();
        std::map<int, std::shared_ptr<const Wavetable>> byCount;
        for (int r = 0; r < Set::ranges; ++r)
        {
            const int count = jmax (1, jmin (maxN, (int) (2048 * std::pow (2.0, -r / 3.0))));
            auto& w = byCount[count];
            if (w == nullptr)
            {
                auto t = std::make_shared<Wavetable>();
                const auto x = count == maxN ? full : render (count);
                for (int i = 0; i < size; ++i) t->table[(size_t) i] = x[(size_t) i] * scale;
                t->table[size] = t->table[0];
                w = t;
            }
            set->tables.push_back (w);
        }
        cache[key] = set;
        return set;
    }
};

// Tone's partial series for the basic types (Oscillator._getRealImaginary).
inline std::vector<double> basicPartials (const String& type, int count = 2047)
{
    std::vector<double> b ((size_t) count, 0.0);
    for (int n = 1; n <= count; ++n)
    {
        const double pf = 2.0 / (n * MathConstants<double>::pi);
        double v = 0;
        if (type == "sine") v = n == 1 ? 1 : 0;
        else if (type == "square") v = (n & 1) ? 2 * pf : 0;
        else if (type == "sawtooth") v = pf * ((n & 1) ? 1 : -1);
        else if (type == "triangle") v = (n & 1) ? 2 * pf * pf * ((((n - 1) >> 1) & 1) ? -1 : 1) : 0;
        b[(size_t) n - 1] = v;
    }
    return b;
}

//==============================================================================
// Tone.OmniOscillator: basic/custom types, "fat" (detuned stack) and "pulse".
struct OscSettings
{
    String type = "sine";          // base type: sine | square | sawtooth | triangle | custom | pulse
    bool fat = false;
    int count = 3;
    double spread = 20, width = 0.2, phaseDeg = 0;
    std::vector<double> partials;  // for custom

    static OscSettings parse (const var& o)
    {
        OscSettings s;
        String t = o.getProperty ("type", "sine").toString();
        if (t.startsWith ("fat")) { s.fat = true; t = t.substring (3); }
        s.type = t;
        s.count = jmax (1, (int) o.getProperty ("count", 3));
        s.spread = (double) o.getProperty ("spread", 20.0);
        s.width = (double) o.getProperty ("width", 0.2);
        s.phaseDeg = (double) o.getProperty ("phase", 0.0);
        if (auto* a = o["partials"].getArray())
            for (auto& v : *a) s.partials.push_back ((double) v);
        return s;
    }
};

class Oscillator
{
public:
    void start (const OscSettings& s, double freq, double sampleRate)
    {
        settings = s;
        rate = sampleRate;
        const int voices = s.fat ? s.count : 1;
        phases.assign ((size_t) voices, 0.0);
        detunes.assign ((size_t) voices, 1.0);
        gain = s.fat ? Decibels::decibelsToGain (-6.0 - s.count * 1.1) : 1.0f;
        for (int i = 0; i < voices; ++i)
        {
            // Fat stacks spread their phases and detune evenly across `spread` cents.
            const double phaseDeg = s.phaseDeg + (s.fat ? (double) i / voices * 360.0 : 0.0);
            phases[(size_t) i] = 0;
            phaseOffsets.resize ((size_t) voices);
            phaseOffsets[(size_t) i] = phaseDeg * MathConstants<double>::pi / 180.0;
            if (s.fat && voices > 1) detunes[(size_t) i] = std::pow (2.0, (-s.spread / 2 + s.spread / (voices - 1) * i) / 1200.0);
        }
        tables.clear();
        ignoreUnused (freq);
        if (s.type == "pulse") return;   // a thresholded triangle, built per sample
        const auto partials = s.type == "custom" ? s.partials : basicPartials (s.type);
        for (int i = 0; i < voices; ++i)
            tables.push_back (Wavetable::make (partials, phaseOffsets[(size_t) i]));
    }

    // One sample at frequency f (Hz). Like Chromium's OscillatorNode, the frequency is limited to
    // ±Nyquist and the waveform loses partials as it rises (so FM doesn't alias).
    float next (double f) noexcept
    {
        double out = 0;
        for (size_t i = 0; i < phases.size(); ++i)
        {
            const double fi = jlimit (-rate / 2, rate / 2, f * detunes[i]);
            const double inc = fi / rate;
            if (settings.type == "pulse")
            {
                // Tone.PulseOscillator: a triangle plus the width, through a sign-like curve.
                const double p = phases[i] - phaseOffsets[i] / MathConstants<double>::twoPi;
                const double tri = triangle (p);
                out += pulseShape (tri + settings.width);
            }
            else
                out += tables[i]->at (phases[i], fi, rate);
            phases[i] += inc;
            phases[i] -= std::floor (phases[i]);
        }
        return (float) (out * gain);
    }

private:
    OscSettings settings;
    double rate = 48000;
    float gain = 1;
    std::vector<double> phases, detunes, phaseOffsets;
    std::vector<std::shared_ptr<const Wavetable::Set>> tables;

    static double triangle (double p)
    {
        // Matches the triangle partial series' shape (peak 1 at a quarter cycle).
        const double x = p - std::floor (p);
        return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
    }

    static float pulseShape (double v)
    {
        // Tone's WaveShaper curve (val <= 0 ? -1 : 1) at 1024 points, interpolated like Web Audio.
        const double n = 1023, idx = n * 0.5 * (jlimit (-1.0, 1.0, v) + 1);
        const int k = (int) idx;
        const auto c = [&] (int i) { const double x = (double) i / n * 2 - 1; return x <= 0 ? -1.0 : 1.0; };
        if (k >= (int) n) return 1.0f;
        const double f = idx - k;
        return (float) (c (k) + (c (k + 1) - c (k)) * f);
    }
};

//==============================================================================
// Tone.Envelope: linear attack from the current value, exponential-approach decay to the sustain
// level and release (Param.exponentialApproachValueAtTime: time constant ln(t+1)/ln(200), finishing
// with a linear ramp over the last 10%).
struct ToneEnvelope
{
    double attack = 0.005, decay = 0.1, sustain = 0.3, release = 1;
    String attackCurve = "linear";
    double rate = 48000;

    enum Stage { idle, attacking, decaying, sustaining, releasing };
    Stage stage = idle;
    double value = 0, from = 0, target = 0, velocity = 1, len = 0;
    int64 t = 0;

    static ToneEnvelope parse (const var& o)
    {
        ToneEnvelope e;
        e.attack = (double) o.getProperty ("attack", 0.005);
        e.decay = (double) o.getProperty ("decay", 0.1);
        e.sustain = (double) o.getProperty ("sustain", 0.3);
        e.release = (double) o.getProperty ("release", 1.0);
        e.attackCurve = o.getProperty ("attackCurve", "linear").toString();
        return e;
    }

    void triggerAttack (double vel)
    {
        velocity = vel;
        double a = attack;
        if (value > 0) a = (1 - value) * attack;     // an unfinished attack only covers the rest
        from = value;
        t = 0;
        if (a < 1.0 / rate) { value = vel; startDecay(); return; }
        stage = attacking; len = a; target = vel;
    }

    void triggerRelease()
    {
        if (value <= 0) { stage = idle; return; }
        if (release < 1.0 / rate) { value = 0; stage = idle; return; }
        stage = releasing; from = value; target = 0; len = release; t = 0;
    }

    float next() noexcept
    {
        const double s = (double) t++ / rate;
        switch (stage)
        {
            case attacking:
                value = attackCurve == "exponential" ? approach (from, target, s, len) : from + (target - from) * jmin (1.0, s / len);
                if (s >= len) { value = target; startDecay(); }
                break;
            case decaying:
                value = approach (from, target, s, len);
                if (s >= len) { value = target; stage = sustaining; }
                break;
            case releasing:
                value = approach (from, 0, s, len);
                if (s >= len) { value = 0; stage = idle; }
                break;
            case sustaining:
            case idle:
                break;
        }
        return (float) value;
    }

    bool silent() const { return stage == idle; }

private:
    void startDecay()
    {
        t = 0;
        if (decay > 0 && sustain < 1) { stage = decaying; from = value; target = velocity * sustain; len = decay; }
        else stage = sustaining;
    }

    static double approach (double a, double b, double s, double length)
    {
        if (length <= 0) return b;
        const double tc = std::log (length + 1) / std::log (200.0);
        const double knee = length * 0.9;
        const auto ex = [&] (double x) { return b + (a - b) * std::exp (-x / tc); };
        if (s < knee) return ex (s);
        const double k = ex (knee);
        return k + (b - k) * jmin (1.0, (s - knee) / (length - knee));
    }
};

//==============================================================================
// Tone.Filter: one RBJ biquad per 12 dB of rolloff, in series.
class ToneFilter
{
public:
    Biquad::Type type = Biquad::lowpass;
    int stages = 1;
    double q = 1, gainDb = 0, rate = 48000;

    static Biquad::Type parseType (const String& t)
    {
        if (t == "highpass") return Biquad::highpass;
        if (t == "peaking") return Biquad::peaking;
        if (t == "lowshelf") return Biquad::lowshelf;
        if (t == "highshelf") return Biquad::highshelf;
        if (t == "bandpass") return Biquad::bandpass;
        return Biquad::lowpass;
    }

    void setup (const var& o, double sr)
    {
        rate = sr;
        type = parseType (o.getProperty ("type", "lowpass").toString());
        const int rolloff = (int) o.getProperty ("rolloff", -12);
        stages = jlimit (1, 8, std::abs (rolloff) / 12);
        q = (double) o.getProperty ("Q", 1.0);
        gainDb = (double) o.getProperty ("gain", 0.0);
        setFrequency ((double) o.getProperty ("frequency", 350.0));
    }

    void setFrequency (double f)
    {
        for (int i = 0; i < stages; ++i) { l[i].set (type, f, q, gainDb, rate); r[i].set (type, f, q, gainDb, rate); }
    }

    float processL (float x) { for (int i = 0; i < stages; ++i) x = l[i].process (x); return x; }
    float processR (float x) { for (int i = 0; i < stages; ++i) x = r[i].process (x); return x; }

private:
    Biquad l[8], r[8];
};

//==============================================================================
// Synth voices. Each renders mono into `out` (adding).
struct ToneLfo
{
    double freq = 1, phase = 0, rate = 48000, min = 0, max = 1, amplitude = 1, t = 0;
    String type = "sine";
    // Tone.LFO: min + (max − min) · (amplitude · wave + 1) / 2, the wave starting at `phase` degrees.
    double next() noexcept
    {
        const double cycles = t * freq / rate - phase / 360.0;
        t += 1;
        double w;
        const double x = cycles - std::floor (cycles);
        if (type == "triangle") w = x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
        else if (type == "square") w = x < 0.5 ? 1 : -1;
        else if (type == "sawtooth") w = x < 0.5 ? 2 * x : 2 * x - 2;
        else w = std::sin (MathConstants<double>::twoPi * cycles);
        return min + (max - min) * (amplitude * w + 1) / 2;
    }
};

class SynthVoice
{
public:
    enum Kind { plain, mono, fm };

    struct Settings
    {
        Kind kind = plain;
        OscSettings osc, modOsc;
        ToneEnvelope env, modEnv, filterEnv;
        var filter;
        double filterBase = 200, filterOctaves = 3, filterExponent = 1;
        double harmonicity = 3, modulationIndex = 10;
        float volumeDb = 0;
        double detuneCents = 0;
    };

    int midi = -1;
    bool released = false;
    int64 age = 0;

    void start (const Settings& s, int note, double velocity, double sampleRate)
    {
        settings = &s;
        rate = sampleRate;
        midi = note;
        released = false;
        freq = 440.0 * std::pow (2.0, (note - 69) / 12.0) * std::pow (2.0, s.detuneCents / 1200.0);
        osc.start (s.osc, freq, rate);
        env = s.env; env.rate = rate; env.value = 0; env.stage = ToneEnvelope::idle; env.triggerAttack (velocity);
        volume = Decibels::decibelsToGain (s.volumeDb);
        if (s.kind == mono)
        {
            filter.setup (s.filter, rate);
            fenv = s.filterEnv; fenv.rate = rate; fenv.value = 0; fenv.stage = ToneEnvelope::idle; fenv.triggerAttack (1);
            counter = 0;
        }
        if (s.kind == fm)
        {
            modOsc.start (s.modOsc, freq * s.harmonicity, rate);
            modEnv = s.modEnv; modEnv.rate = rate; modEnv.value = 0; modEnv.stage = ToneEnvelope::idle; modEnv.triggerAttack (velocity);
        }
    }

    void release()
    {
        released = true;
        env.triggerRelease();
        if (settings->kind == mono) fenv.triggerRelease();
        if (settings->kind == fm) modEnv.triggerRelease();
    }

    bool silent() const { return released && env.silent(); }

    void render (float* out, int from, int n)
    {
        const auto& s = *settings;
        for (int i = from; i < n; ++i)
        {
            float x;
            if (s.kind == fm)
            {
                // ModulationSynth: both voices at -10 dB; the modulator's output, times
                // frequency · modulationIndex, is added to the carrier's frequency.
                const double m = modOsc.next (freq * s.harmonicity) * modEnv.next() * minus10;
                x = osc.next (freq + m * freq * s.modulationIndex) * env.next() * minus10;
            }
            else if (s.kind == mono)
            {
                // MonoSynth: oscillator -> filter (frequency from the filter envelope) -> amplitude envelope.
                // Coefficients follow the envelope every sample, as Web Audio does for an audio-rate frequency.
                const double e = fenv.next();
                if (std::abs (e - lastFilterEnv) > 1e-6 || counter++ == 0)
                    lastFilterEnv = e, filter.setFrequency (s.filterBase + (s.filterBase * std::pow (2.0, s.filterOctaves) - s.filterBase) * std::pow (jmax (0.0, e), s.filterExponent));
                x = filter.processL (osc.next (freq)) * env.next();
            }
            else
                x = osc.next (freq) * env.next();
            out[i] += x * volume;
        }
    }

private:
    const Settings* settings = nullptr;
    double rate = 48000, freq = 440;
    Oscillator osc, modOsc;
    ToneEnvelope env, modEnv, fenv;
    ToneFilter filter;
    float volume = 1;
    int counter = 0;
    double lastFilterEnv = -1;
    static constexpr double minus10 = 0.31622776601683794;
};

//==============================================================================
// The synth drum kit's voices (instruments.js makeSynthKit). Each is monophonic like Tone's: a new hit
// restarts the oscillators and takes the envelope from wherever it is.

inline double toneVolume (const var& o) { return Decibels::decibelsToGain ((double) o.getProperty ("volume", 0.0)); }

// Tone.MembraneSynth: a sine sweeping exponentially from note × octaves down to the note.
class MembraneVoice
{
public:
    void setup (const var& o, double sr)
    {
        rate = sr;
        pitchDecay = (double) o.getProperty ("pitchDecay", 0.05);
        octaves = (double) o.getProperty ("octaves", 10.0);
        env = ToneEnvelope::parse (o["envelope"]); env.rate = sr;
        gain = (float) toneVolume (o);
    }

    void trigger (double hz, double velocity, int64 lengthSamples)
    {
        f0 = hz * octaves; f1 = hz; t = 0; phase = 0;
        env.triggerAttack (velocity);
        releaseAt = lengthSamples;
    }

    void render (float* L, float* R, int n)
    {
        for (int i = 0; i < n; ++i)
        {
            if (t == releaseAt) env.triggerRelease();
            const double s = (double) t++ / rate;
            const double f = s < pitchDecay ? f0 * std::pow (f1 / f0, s / pitchDecay) : f1;
            const float e = env.next();
            if (e == 0.0f && env.silent()) { phase += f / rate; continue; }
            const float x = (float) std::sin (MathConstants<double>::twoPi * phase) * e * gain;
            phase += f / rate;
            L[i] += x; R[i] += x;
        }
    }

private:
    double rate = 48000, pitchDecay = 0.05, octaves = 10, f0 = 440, f1 = 440, phase = 0;
    ToneEnvelope env;
    float gain = 1;
    int64 t = 0, releaseAt = -1;
};

// Tone.NoiseSynth: stereo noise (independent channels, as Tone's buffers are) through an envelope,
// then the kit's band-pass filter.
class NoiseVoice
{
public:
    void setup (const var& o, const var& filterOptions, double sr)
    {
        env = ToneEnvelope::parse (o["envelope"]); env.rate = sr;
        pink = o["noise"].getProperty ("type", "white").toString() == "pink";
        gain = (float) toneVolume (o);
        filter.setup (filterOptions, sr);
    }

    void trigger (double velocity, int64 lengthSamples) { t = 0; env.triggerAttack (velocity); releaseAt = lengthSamples; }

    void render (float* L, float* R, int n)
    {
        for (int i = 0; i < n; ++i)
        {
            if (t++ == releaseAt) env.triggerRelease();
            const float e = env.next() * gain;
            const float l = noise (0) * e, r = noise (1) * e;
            L[i] += filter.processL (l);
            R[i] += filter.processR (r);
        }
    }

private:
    ToneEnvelope env;
    ToneFilter filter;
    bool pink = false;
    float gain = 1;
    int64 t = 0, releaseAt = -1;
    Random random;
    double b[2][7] {};

    float noise (int c)
    {
        const double white = random.nextDouble() * 2 - 1;
        if (! pink) return (float) white;
        auto& k = b[c];   // Paul Kellet's pink filter, as Tone generates it
        k[0] = 0.99886 * k[0] + white * 0.0555179; k[1] = 0.99332 * k[1] + white * 0.0750759;
        k[2] = 0.969 * k[2] + white * 0.153852;    k[3] = 0.8665 * k[3] + white * 0.3104856;
        k[4] = 0.55 * k[4] + white * 0.5329522;    k[5] = -0.7616 * k[5] - white * 0.016898;
        const double out = (k[0] + k[1] + k[2] + k[3] + k[4] + k[5] + k[6] + white * 0.5362) * 0.11;
        k[6] = white * 0.115926;
        return (float) out;
    }
};

// Tone.MetalSynth: six square-wave FM oscillators at inharmonic ratios, through a high-pass whose
// cutoff follows the envelope (resonance up `octaves`), all scaled by the envelope.
class MetalVoice
{
public:
    void setup (const var& o, double sr)
    {
        rate = sr;
        harmonicity = (double) o.getProperty ("harmonicity", 5.1);
        modIndex = (double) o.getProperty ("modulationIndex", 32.0);
        resonance = (double) o.getProperty ("resonance", 4000.0);
        octaves = (double) o.getProperty ("octaves", 1.5);
        env = ToneEnvelope::parse (o["envelope"]); env.rate = sr; env.sustain = 0; env.attackCurve = "linear";
        gain = (float) toneVolume (o);
    }

    void trigger (double hz, double velocity, int64 lengthSamples)
    {
        static const double ratios[6] = { 1.0, 1.483, 1.932, 2.546, 2.63, 3.897 };
        OscSettings sq; sq.type = "square";
        for (int i = 0; i < 6; ++i)
        {
            freqs[i] = hz * ratios[i];
            carriers[i].start (sq, freqs[i], rate);
            modulators[i].start (sq, freqs[i] * harmonicity, rate);
        }
        env.triggerAttack (velocity);
        t = 0; releaseAt = lengthSamples; active = true;
    }

    void release() { env.triggerRelease(); }

    void render (float* L, float* R, int n)
    {
        if (! active) return;
        for (int i = 0; i < n; ++i)
        {
            if (t++ == releaseAt) env.triggerRelease();
            const double e = env.next();
            if (env.silent() && e == 0) { active = false; return; }
            double sum = 0;
            for (int k = 0; k < 6; ++k)
            {
                const double m = modulators[k].next (freqs[k] * harmonicity);
                sum += carriers[k].next (freqs[k] + m * freqs[k] * modIndex);
            }
            // The high-pass (Q 0 dB) follows the envelope from `resonance` up `octaves`.
            hp.set (Biquad::highpass, resonance + (resonance * std::pow (2.0, octaves) - resonance) * e, 0, 0, rate);
            const float x = hp.process ((float) sum) * (float) e * gain;
            L[i] += x; R[i] += x;
        }
    }

private:
    double rate = 48000, harmonicity = 5.1, modIndex = 32, resonance = 4000, octaves = 1.5;
    double freqs[6] {};
    Oscillator carriers[6], modulators[6];
    ToneEnvelope env;
    Biquad hp;
    bool active = false;
    float gain = 1;
    int64 t = 0, releaseAt = -1;
};

//==============================================================================
// Effects, processing a stereo pair in place (mono sources arrive with L == R, as Tone's
// StereoEffect upmixes them). Wet/dry is Tone's equal-power CrossFade.
class Effect
{
public:
    virtual ~Effect() = default;
    virtual void process (float* L, float* R, int n) = 0;

protected:
    float dryGain = 0, wetGain = 1;
    void setWet (double wet) { dryGain = (float) std::cos (wet * MathConstants<double>::halfPi); wetGain = (float) std::sin (wet * MathConstants<double>::halfPi); }
};

// A fractional delay line with linear interpolation (Web Audio DelayNode).
struct DelayLine
{
    std::vector<float> buf;
    int w = 0;
    void prepare (int maxSamples) { buf.assign ((size_t) maxSamples + 4, 0.0f); w = 0; }
    float process (float x, double delaySamples)
    {
        const int size = (int) buf.size();
        buf[(size_t) w] = x;
        double r = w - delaySamples;
        while (r < 0) r += size;
        const int k = (int) r;
        const float f = (float) (r - k);
        const float a = buf[(size_t) k], b = buf[(size_t) ((k + 1) % size)];
        w = (w + 1) % size;
        return a + (b - a) * f;
    }
};

class ChorusEffect final : public Effect
{
public:
    ChorusEffect (const var& o, double sr) : rate (sr)
    {
        const double delay = (double) o.getProperty ("delayTime", 3.5) / 1000.0, depth = (double) o.getProperty ("depth", 0.7);
        const double spread = (double) o.getProperty ("spread", 180.0), dev = delay * depth;
        for (auto* l : { &lfoL, &lfoR })
        {
            l->rate = rate; l->freq = (double) o.getProperty ("frequency", 1.5);
            l->min = jmax (delay - dev, 0.0); l->max = delay + dev;
            l->type = o.getProperty ("type", "sine").toString();
        }
        lfoL.phase = 90 - spread / 2;
        lfoR.phase = spread / 2 + 90;
        dl.prepare ((int) (rate * 0.1)); dr.prepare ((int) (rate * 0.1));
        setWet ((double) o.getProperty ("wet", 0.5));
    }

    void process (float* L, float* R, int n) override
    {
        for (int i = 0; i < n; ++i)
        {
            const float l = dl.process (L[i], lfoL.next() * rate), r = dr.process (R[i], lfoR.next() * rate);
            L[i] = L[i] * dryGain + l * wetGain;
            R[i] = R[i] * dryGain + r * wetGain;
        }
    }

private:
    double rate;
    ToneLfo lfoL, lfoR;
    DelayLine dl, dr;
};

class TremoloEffect final : public Effect
{
public:
    TremoloEffect (const var& o, double sr)
    {
        const double spread = (double) o.getProperty ("spread", 180.0);
        for (auto* l : { &lfoL, &lfoR })
        {
            l->rate = sr; l->freq = (double) o.getProperty ("frequency", 10.0);
            l->min = 1; l->max = 0; l->amplitude = (double) o.getProperty ("depth", 0.5);
            l->type = o.getProperty ("type", "sine").toString();
        }
        lfoL.phase = 90 - spread / 2;
        lfoR.phase = spread / 2 + 90;
        setWet ((double) o.getProperty ("wet", 1.0));
    }

    void process (float* L, float* R, int n) override
    {
        for (int i = 0; i < n; ++i)
        {
            const float gl = (float) lfoL.next(), gr = (float) lfoR.next();
            L[i] = L[i] * dryGain + L[i] * gl * wetGain;
            R[i] = R[i] * dryGain + R[i] * gr * wetGain;
        }
    }

private:
    ToneLfo lfoL, lfoR;
};

class VibratoEffect final : public Effect
{
public:
    VibratoEffect (const var& o, double sr) : rate (sr)
    {
        lfo.rate = sr; lfo.freq = (double) o.getProperty ("frequency", 5.0);
        lfo.min = 0; lfo.max = (double) o.getProperty ("maxDelay", 0.005);
        lfo.amplitude = (double) o.getProperty ("depth", 0.1);
        lfo.phase = -90;
        lfo.type = o.getProperty ("type", "sine").toString();
        dl.prepare ((int) (sr * 0.05)); dr.prepare ((int) (sr * 0.05));
        setWet ((double) o.getProperty ("wet", 1.0));
    }

    void process (float* L, float* R, int n) override
    {
        for (int i = 0; i < n; ++i)
        {
            const double d = lfo.next() * rate;
            const float l = dl.process (L[i], d), r = dr.process (R[i], d);
            L[i] = L[i] * dryGain + l * wetGain;
            R[i] = R[i] * dryGain + r * wetGain;
        }
    }

private:
    double rate;
    ToneLfo lfo;
    DelayLine dl, dr;
};

class FeedbackDelayEffect final : public Effect
{
public:
    FeedbackDelayEffect (const var& o, double sr)
    {
        const int d = jmax (1, (int) std::lround ((double) o.getProperty ("delayTime", 0.25) * sr));
        for (auto* x : { &dl, &dr }) { x->prepare (d); x->setDelay (d); x->feedback = (float) (double) o.getProperty ("feedback", 0.125); }
        setWet ((double) o.getProperty ("wet", 0.5));
    }

    void process (float* L, float* R, int n) override
    {
        for (int i = 0; i < n; ++i)
        {
            const float l = dl.process (L[i]), r = dr.process (R[i]);
            L[i] = L[i] * dryGain + l * wetGain;
            R[i] = R[i] * dryGain + r * wetGain;
        }
    }

private:
    WebFeedbackDelay dl, dr;
};

class FilterEffect final : public Effect
{
public:
    FilterEffect (const var& o, double sr) { filter.setup (o, sr); }
    void process (float* L, float* R, int n) override
    {
        for (int i = 0; i < n; ++i) { L[i] = filter.processL (L[i]); R[i] = filter.processR (R[i]); }
    }

private:
    ToneFilter filter;
};

class DistortionEffect final : public Effect
{
public:
    DistortionEffect (const var& o, double sr, int maxBlock)
    {
        const String os = o.getProperty ("oversample", "none").toString();
        const int factor = os == "4x" ? 2 : os == "2x" ? 1 : 0;
        for (auto* s : { &l, &r }) { s->prepare (factor, maxBlock); s->curve = distortionCurve ((double) o.getProperty ("distortion", 0.4)); }
        setWet ((double) o.getProperty ("wet", 1.0));
        ignoreUnused (sr);
        wl.resize ((size_t) maxBlock); wr.resize ((size_t) maxBlock);
    }

    void process (float* L, float* R, int n) override
    {
        memcpy (wl.data(), L, sizeof (float) * (size_t) n);
        memcpy (wr.data(), R, sizeof (float) * (size_t) n);
        l.process (wl.data(), n);
        r.process (wr.data(), n);
        for (int i = 0; i < n; ++i) { L[i] = L[i] * dryGain + wl[(size_t) i] * wetGain; R[i] = R[i] * dryGain + wr[(size_t) i] * wetGain; }
    }

private:
    Shaper l, r;
    std::vector<float> wl, wr;
};

inline std::unique_ptr<Effect> makeEffect (const var& e, double sr, int maxBlock)
{
    const String name = e["name"];
    const var o = e["options"];
    if (name == "Chorus") return std::make_unique<ChorusEffect> (o, sr);
    if (name == "Tremolo") return std::make_unique<TremoloEffect> (o, sr);
    if (name == "Vibrato") return std::make_unique<VibratoEffect> (o, sr);
    if (name == "FeedbackDelay") return std::make_unique<FeedbackDelayEffect> (o, sr);
    if (name == "Filter") return std::make_unique<FilterEffect> (o, sr);
    if (name == "Distortion") return std::make_unique<DistortionEffect> (o, sr, maxBlock);
    return nullptr;
}

} // namespace bb
