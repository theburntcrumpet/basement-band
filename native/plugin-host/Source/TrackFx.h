// Native port of src/engine/effects.js: the Vinyl, Tape, Radio and Lo-Fi character effects for a
// track or the master bus. The noise textures use the same seeded generator and maths as the app,
// so they're the same sounds; noise layers only play while the song does.

#pragma once

#include <juce_dsp/juce_dsp.h>
#include <functional>
#include <map>

namespace bb
{
using namespace juce;

// effects.js rng(): a 32-bit LCG.
struct Lcg
{
    uint32_t s;
    explicit Lcg (uint32_t seed) : s (seed) {}
    double next() { s = s * 1664525u + 1013904223u; return s / 4294967296.0; }
};

// effects.js texture(): looping stereo noise, generated once per kind and sample rate.
inline const AudioBuffer<float>& fxTexture (const String& kind, double rate)
{
    static CriticalSection lock;
    static std::map<String, std::unique_ptr<AudioBuffer<float>>> cache;
    const ScopedLock l (lock);
    const String key = kind + ":" + String (rate);
    if (auto it = cache.find (key); it != cache.end()) return *it->second;
    const double seconds = kind == "crackle" ? 9.7 : kind == "pops" ? 13.3 : 5.1;
    const int len = (int) std::floor (seconds * rate);
    auto buf = std::make_unique<AudioBuffer<float>> (2, len);
    buf->clear();
    Lcg rand (kind == "crackle" ? 101 : kind == "pops" ? 202 : 303);
    if (kind == "pops")
    {
        auto* L = buf->getWritePointer (0); auto* R = buf->getWritePointer (1);
        for (int t = 0; t < len;)
        {
            t += (int) std::floor ((-std::log (1 - rand.next()) / 0.7) * rate);
            if (t >= len) break;
            const double amp = 0.3 + 0.7 * rand.next();
            const int width = (int) std::floor (rate * (0.0006 + 0.002 * rand.next()));
            const double pan = (rand.next() - 0.5) * 0.4;
            for (int i = 0; i < width * 6 && t + i < len; ++i)
            {
                const double env = std::exp (-(double) i / width);
                const double v = amp * env * (i < 2 ? 1 : (rand.next() * 2 - 1) * 0.6);
                L[t + i] += (float) (v * (1 - pan));
                R[t + i] += (float) (v * (1 + pan));
            }
        }
    }
    else
        for (int c = 0; c < 2; ++c)
        {
            auto* d = buf->getWritePointer (c);
            if (kind == "crackle")
            {
                double lp = 0;
                for (int i = 0; i < len; ++i) { lp += 0.05 * ((rand.next() * 2 - 1) - lp); d[i] = (float) (lp * 0.02); }
                for (int t = 0; t < len;)
                {
                    t += (int) std::floor ((-std::log (1 - rand.next()) / 80) * rate);
                    if (t + 4 >= len) break;
                    const double amp = std::pow (rand.next(), 3.5) * 0.9 * (rand.next() < 0.5 ? -1 : 1);
                    d[t] += (float) amp; d[t + 1] -= (float) (amp * 0.6); d[t + 2] += (float) (amp * 0.25);
                }
            }
            else
            {
                double lp = 0;
                for (int i = 0; i < len; ++i) { const double w = rand.next() * 2 - 1; lp += 0.4 * (w - lp); d[i] = (float) ((w * 0.5 + lp * 0.5) * 0.5); }
            }
        }
    auto* raw = buf.get();
    cache[key] = std::move (buf);
    return *raw;
}

inline std::vector<float> curveOf (std::function<double (double)> fn, int n = 4096)
{
    std::vector<float> c ((size_t) n);
    for (int i = 0; i < n; ++i) c[(size_t) i] = (float) fn ((double) i / (n - 1) * 2 - 1);
    return c;
}

inline std::vector<float> saturateCurve (double k) { return curveOf ([k] (double x) { return std::tanh (k * x) / std::tanh (k); }); }
inline std::vector<float> crushCurve (int bits)
{
    const double steps = std::pow (2.0, bits - 1);
    return curveOf ([steps] (double x) { return std::round (x * steps) / steps; }, 65536);
}

// A looping texture player.
struct TexturePlayer
{
    const AudioBuffer<float>* buf = nullptr;
    int pos = 0;
    void set (const String& kind, double rate) { buf = &fxTexture (kind, rate); pos = 0; }
    void next (float& l, float& r)
    {
        l = buf->getSample (0, pos); r = buf->getSample (1, pos);
        if (++pos >= buf->getNumSamples()) pos = 0;
    }
};

// effects.js wobble(): a delay line wobbling around 8 ms (wow at 0.55 Hz, flutter at 6.3 Hz).
struct Wobble
{
    double rate = 48000, slowPhase = 0, fastPhase = 0;
    Smoothed slowDepth, fastDepth;
    std::vector<float> l, r;
    int w = 0;
    void prepare (double sr) { rate = sr; l.assign ((size_t) (sr * 0.05) + 4, 0); r = l; slowDepth.prepare (sr, 0.05); fastDepth.prepare (sr, 0.05); }
    void set (double wow, bool jump) { slowDepth.setTarget ((float) (wow * 0.0024), jump); fastDepth.setTarget ((float) (wow * 0.00016), jump); }
    void process (float& a, float& b)
    {
        const double d = (0.008 + std::sin (MathConstants<double>::twoPi * slowPhase) * slowDepth.next() + std::sin (MathConstants<double>::twoPi * fastPhase) * fastDepth.next()) * rate;
        slowPhase += 0.55 / rate; fastPhase += 6.3 / rate;
        const int size = (int) l.size();
        l[(size_t) w] = a; r[(size_t) w] = b;
        double rp = w - d;
        while (rp < 0) rp += size;
        const int k = (int) rp; const float f = (float) (rp - k);
        const int k1 = (k + 1) % size;
        a = l[(size_t) k] + (l[(size_t) k1] - l[(size_t) k]) * f;
        b = r[(size_t) k] + (r[(size_t) k1] - r[(size_t) k]) * f;
        w = (w + 1) % size;
    }
};

// FxSlot: the effect on its wet path, mixed with the dry signal; stereo in place.
class FxSlot
{
public:
    void prepare (double sr) { rate = sr; type = {}; for (auto* s : { &dry, &wet, &noiseGate, &g1, &g2, &g3 }) s->prepare (sr, 0.03); noiseGate.prepare (sr, 0.02); wobble.prepare (sr); }

    void setRunning (bool on) { running = on; noiseGate.setTarget (on ? 1.0f : 0.0f); }

    void configure (const var& fx)
    {
        const String t = fx.isObject() ? fx.getProperty ("type", "none").toString() : String ("none");
        const bool rebuild = t != type;
        type = t;
        if (type == "none" || type.isEmpty()) return;
        auto p = [&] (const char* k, double def) { return (double) fx.getProperty (k, def); };
        const bool jump = rebuild;
        dry.setTarget ((float) (1 - p ("mix", 1)), jump);
        wet.setTarget ((float) p ("mix", 1), jump);
        if (rebuild)
        {
            noiseGate.setTarget (running ? 1.0f : 0.0f, true);   // a new effect starts in the right state
            for (auto& b : f) for (auto& x : b) x.reset();
            if (type == "vinyl") { tex1.set ("crackle", rate); tex2.set ("pops", rate); }
            else tex1.set ("hiss", rate);
            bits = -1;
        }
        if (type == "vinyl")
        {
            const double age = p ("age", 0.5), top = 18000 * std::pow (0.2, age);
            setF (0, Biquad::highpass, 25 + age * 170, 0.7); setF (1, Biquad::lowpass, top, 0.7); setF (2, Biquad::lowpass, top, 0.7);
            setF (3, Biquad::lowpass, jmin (12000.0, top * 1.4), 0.7);
            shaper = saturateCurve (1 + age * 2.5);
            wobble.set (p ("wow", 0.3), jump);
            g1.setTarget ((float) (std::pow (p ("crackle", 0.45), 1.5) * 0.5), jump);
            g2.setTarget ((float) (std::pow (p ("pops", 0.35), 1.5) * 0.7), jump);
        }
        else if (type == "tape")
        {
            const double s = p ("saturation", 0.4), warmth = p ("warmth", 0.4);
            g1.setTarget ((float) (1 + s * 1.5), jump);              // drive
            shaper = saturateCurve (1 + s * 5);
            g2.setTarget ((float) (1 / (1 + s * 0.8)), jump);        // trim
            setF (0, Biquad::peaking, 110, 0.8, warmth * 3);
            setF (1, Biquad::lowpass, 16000 * std::pow (0.3, warmth), 0.7);
            wobble.set (p ("wow", 0.25), jump);
            g3.setTarget ((float) (p ("hiss", 0.15) * 0.035), jump);
        }
        else if (type == "radio")
        {
            const double band = p ("band", 0.5), dist = p ("distortion", 0.3);
            setF (0, Biquad::highpass, 250 + band * 650, 1); setF (1, Biquad::lowpass, 6000 - band * 3600, 1);
            setF (2, Biquad::peaking, 1600, 1.2, 5);
            g1.setTarget ((float) (1 + dist * 5), jump);
            shaper = saturateCurve (1 + dist * 4);
            g2.setTarget ((float) (1.6 / (1 + dist * 2)), jump);
            setF (3, Biquad::bandpass, 2500, 0.8);
            g3.setTarget ((float) (p ("static", 0.2) * 0.12), jump);
        }
        else if (type == "lofi")
        {
            const int b = (int) std::lround (16 - p ("crush", 0.5) * 12);
            if (b != bits) { shaper = crushCurve (b); bits = b; }
            setF (0, Biquad::lowpass, 14000 * std::pow (0.15, p ("tone", 0.5)), 0.7);
            setF (1, Biquad::highpass, 70, 0.7);
            g3.setTarget ((float) (p ("noise", 0.15) * 0.03), jump);
        }
    }

    bool active() const { return type.isNotEmpty() && type != "none"; }

    void process (float* L, float* R, int n)
    {
        if (! active()) return;
        for (int i = 0; i < n; ++i)
        {
            float a = L[i], b = R[i], na = 0, nb = 0;
            const float gate = noiseGate.next();
            if (type == "vinyl")
            {
                a = shape (f[2][0].process (f[1][0].process (f[0][0].process (a))));
                b = shape (f[2][1].process (f[1][1].process (f[0][1].process (b))));
                wobble.process (a, b);
                float c1, c2, p1, p2;
                tex1.next (c1, c2); tex2.next (p1, p2);
                const float k = g1.next(), pk = g2.next();
                na = f[3][0].process ((c1 * k + p1 * pk) * gate);
                nb = f[3][1].process ((c2 * k + p2 * pk) * gate);
            }
            else if (type == "tape")
            {
                const float d = g1.next(), tr = g2.next();
                a = f[1][0].process (f[0][0].process (shape (a * d) * tr));
                b = f[1][1].process (f[0][1].process (shape (b * d) * tr));
                wobble.process (a, b);
                float h1, h2; tex1.next (h1, h2);
                const float hg = g3.next() * gate;
                na = h1 * hg; nb = h2 * hg;
            }
            else if (type == "radio")
            {
                const float d = g1.next(), tr = g2.next();
                a = shape (f[2][0].process (f[1][0].process (f[0][0].process (a))) * d) * tr;
                b = shape (f[2][1].process (f[1][1].process (f[0][1].process (b))) * d) * tr;
                float h1, h2; tex1.next (h1, h2);
                const float hg = g3.next() * gate;
                na = f[3][0].process (h1) * hg; nb = f[3][1].process (h2) * hg;
            }
            else if (type == "lofi")
            {
                a = f[1][0].process (f[0][0].process (shape (a)));
                b = f[1][1].process (f[0][1].process (shape (b)));
                float h1, h2; tex1.next (h1, h2);
                const float hg = g3.next() * gate;
                na = h1 * hg; nb = h2 * hg;
            }
            const float dg = dry.next(), wg = wet.next();
            L[i] = L[i] * dg + (a + na) * wg;
            R[i] = R[i] * dg + (b + nb) * wg;
        }
    }

private:
    double rate = 48000;
    bool running = false;
    String type;
    Smoothed dry, wet, noiseGate, g1, g2, g3;
    Biquad f[4][2];
    std::vector<float> shaper;
    int bits = -1;
    Wobble wobble;
    TexturePlayer tex1, tex2;

    void setF (int i, Biquad::Type t, double freq, double q, double gain = 0) { f[i][0].set (t, freq, q, gain, rate); f[i][1].set (t, freq, q, gain, rate); }

    float shape (float x) const
    {
        // Web Audio WaveShaper lookup with linear interpolation.
        const int n = (int) shaper.size();
        if (n == 0) return x;
        const float v = (float) (n - 1) * 0.5f * (x + 1);
        if (v <= 0) return shaper.front();
        if (v >= (float) (n - 1)) return shaper.back();
        const int k = (int) v;
        const float fr = v - (float) k;
        return shaper[(size_t) k] * (1 - fr) + shaper[(size_t) k + 1] * fr;
    }
};

} // namespace bb
