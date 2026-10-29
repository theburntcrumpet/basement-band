// Native ports of Basement Band's track DSP (src/engine/amp.js, amp-worklet.js, engine.js TrackNode,
// master-worklet.js), so live monitoring through the helper sounds like playback in the app.
// Filters use the Web Audio spec's biquad formulas (including its quirks: lowpass/highpass Q is in
// dB, shelves have slope 1) and wave shapers interpolate their curves the way Web Audio does.

#pragma once

#include <juce_dsp/juce_dsp.h>
#include <cmath>
#include <random>

namespace bb
{
using namespace juce;

//==============================================================================
// Tone.FeedbackDelay as Chromium runs it: the first repeat arrives after exactly the delay time, but a
// feedback loop through a DelayNode is processed a render quantum (128 frames) late, so each further
// repeat is 128 frames later still: y[n] = x[n − D] + feedback · y[n − D − 128].
struct WebFeedbackDelay
{
    static constexpr int quantum = 128;
    std::vector<float> x, y;
    int d = 1, w = 0;
    float feedback = 0;

    void prepare (int maxDelaySamples) { x.assign ((size_t) maxDelaySamples + quantum + 2, 0.0f); y = x; w = 0; }
    void setDelay (int samples) { d = jlimit (1, (int) x.size() - quantum - 1, samples); }

    float process (float in) noexcept
    {
        const int size = (int) x.size();
        x[(size_t) w] = in;
        const float out = x[(size_t) ((w - d + size) % size)] + feedback * y[(size_t) ((w - d - quantum + 2 * size) % size)];
        y[(size_t) w] = out;
        w = (w + 1) % size;
        return out;
    }
};

// Web Audio BiquadFilterNode, one channel.
struct Biquad
{
    enum Type { lowpass, highpass, peaking, lowshelf, highshelf, bandpass };

    Type type = lowpass;
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    double x1 = 0, x2 = 0, y1 = 0, y2 = 0;

    void set (Type t, double freq, double q, double gainDb, double rate)
    {
        type = t;
        const double nyquist = rate / 2;
        const double f = jlimit (1.0, nyquist * 0.9999, freq);
        const double w0 = MathConstants<double>::twoPi * f / rate;
        const double cs = std::cos (w0), sn = std::sin (w0);
        const double A = std::pow (10.0, gainDb / 40.0);
        double B0, B1, B2, A0, A1, A2;
        switch (t)
        {
            case lowpass:
            case highpass:
            {
                const double alpha = sn / (2 * std::pow (10.0, q / 20.0));
                const double k = t == lowpass ? (1 - cs) : (1 + cs);
                B0 = k / 2; B1 = t == lowpass ? k : -k; B2 = k / 2;
                A0 = 1 + alpha; A1 = -2 * cs; A2 = 1 - alpha;
                break;
            }
            case bandpass:
            {
                const double alpha = sn / (2 * jmax (1.0e-4, q));
                B0 = alpha; B1 = 0; B2 = -alpha;
                A0 = 1 + alpha; A1 = -2 * cs; A2 = 1 - alpha;
                break;
            }
            case peaking:
            {
                const double alpha = sn / (2 * jmax (1.0e-4, q));
                B0 = 1 + alpha * A; B1 = -2 * cs; B2 = 1 - alpha * A;
                A0 = 1 + alpha / A; A1 = -2 * cs; A2 = 1 - alpha / A;
                break;
            }
            case lowshelf:
            case highshelf:
            default:
            {
                const double alpha = sn / 2 * std::sqrt (2.0);
                const double k = 2 * std::sqrt (A) * alpha;
                if (t == lowshelf)
                {
                    B0 = A * ((A + 1) - (A - 1) * cs + k); B1 = 2 * A * ((A - 1) - (A + 1) * cs); B2 = A * ((A + 1) - (A - 1) * cs - k);
                    A0 = (A + 1) + (A - 1) * cs + k; A1 = -2 * ((A - 1) + (A + 1) * cs); A2 = (A + 1) + (A - 1) * cs - k;
                }
                else
                {
                    B0 = A * ((A + 1) + (A - 1) * cs + k); B1 = -2 * A * ((A - 1) + (A + 1) * cs); B2 = A * ((A + 1) + (A - 1) * cs - k);
                    A0 = (A + 1) - (A - 1) * cs + k; A1 = 2 * ((A - 1) - (A + 1) * cs); A2 = (A + 1) - (A - 1) * cs - k;
                }
                break;
            }
        }
        b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0;
    }

    float process (float x) noexcept
    {
        const double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return (float) y;
    }

    void reset() noexcept { x1 = x2 = y1 = y2 = 0; }
};

//==============================================================================
// Web Audio WaveShaperNode curve lookup, optionally oversampled (mono).
struct Shaper
{
    std::vector<float> curve;
    std::unique_ptr<dsp::Oversampling<float>> os;

    void prepare (int factorLog2, int maxBlock)
    {
        if (factorLog2 > 0)
        {
            os = std::make_unique<dsp::Oversampling<float>> (1, (size_t) factorLog2, dsp::Oversampling<float>::filterHalfBandPolyphaseIIR, false);
            os->initProcessing ((size_t) maxBlock);
        }
        else
            os.reset();
    }

    float lookup (float x) const noexcept
    {
        const auto n = (int) curve.size();
        if (n == 0) return x;
        const float v = (float) (n - 1) * 0.5f * (x + 1.0f);
        if (v <= 0) return curve.front();
        if (v >= (float) (n - 1)) return curve.back();
        const int k = (int) v;
        const float f = v - (float) k;
        return curve[(size_t) k] * (1 - f) + curve[(size_t) k + 1] * f;
    }

    void process (float* data, int n)
    {
        if (os == nullptr)
        {
            for (int i = 0; i < n; ++i) data[i] = lookup (data[i]);
            return;
        }
        float* chans[] = { data };
        dsp::AudioBlock<float> block (chans, 1, (size_t) n);
        auto up = os->processSamplesUp (block);
        auto* p = up.getChannelPointer (0);
        for (size_t i = 0; i < up.getNumSamples(); ++i) p[i] = lookup (p[i]);
        os->processSamplesDown (block);
    }

    void reset() { if (os) os->reset(); }
};

// amp.js tubeCurve(): asymmetric soft clipping, like a triode stage.
inline std::vector<float> tubeCurve (double drive, double bias)
{
    const int n = 8192;
    std::vector<float> c ((size_t) n);
    double norm = std::tanh (drive * (1 + bias));
    if (norm == 0) norm = 1;
    for (int i = 0; i < n; ++i)
    {
        const double x = (double) i / (n - 1) * 2 - 1;
        c[(size_t) i] = (float) ((std::tanh (drive * (x + bias)) - std::tanh (drive * bias)) / norm);
    }
    return c;
}

// Tone.Distortion's curve (1024 points).
inline std::vector<float> distortionCurve (double amount)
{
    const int n = 1024;
    std::vector<float> c ((size_t) n);
    const double k = amount * 100, deg = MathConstants<double>::pi / 180;
    for (int i = 0; i < n; ++i)
    {
        const double x = (double) i / (n - 1) * 2 - 1;
        c[(size_t) i] = std::abs (x) < 0.001 ? 0.0f : (float) ((3 + k) * x * 20 * deg / (MathConstants<double>::pi + k * std::abs (x)));
    }
    return c;
}

// Scales an impulse response the way Web Audio's ConvolverNode normalises (normalize = true), so
// convolution levels match the app.
inline void webAudioNormalise (AudioBuffer<float>& b, double rate)
{
    double power = 0;
    for (int c = 0; c < b.getNumChannels(); ++c)
        for (int i = 0; i < b.getNumSamples(); ++i) power += (double) b.getSample (c, i) * b.getSample (c, i);
    power = std::sqrt (power / jmax (1, b.getNumChannels() * b.getNumSamples()));
    if (! std::isfinite (power) || power < 0.000125) power = 0.000125;
    b.applyGain ((float) (1.0 / power * 0.00125 * 44100.0 / rate));
}

// One-pole smoothing for parameter changes (like setTargetAtTime with a 20 ms time constant).
struct Smoothed
{
    float value = 0, target = 0, coeff = 0;
    void prepare (double rate, double tau = 0.02) { coeff = (float) std::exp (-1.0 / (tau * rate)); }
    void setTarget (float t, bool jump = false) { target = t; if (jump) value = t; }
    float next() noexcept { value = target + (value - target) * coeff; return value; }
};

//==============================================================================
// amp-worklet.js: noise gate with hysteresis and hold, then sustain (lifts fading tails so
// high-gain notes let go gradually). Keep in step with the worklet.
struct Gate
{
    double env = 0, gain = 0, envRelease = 0, attack = 0, release = 0;
    double susEnv = 0, susGainDb = 0, susAttack = 0, susRelease = 0, susSmooth = 0;
    int hold = 0, holdSamples = 0;
    bool open = false;
    float thresholdDb = -100, sustain = 0;

    void prepare (double sr)
    {
        envRelease = std::exp (-1 / (0.02 * sr));
        attack = 1 - std::exp (-1 / (0.0008 * sr));
        release = 1 - std::exp (-1 / (0.08 * sr));
        holdSamples = (int) std::floor (0.05 * sr);
        susAttack = 1 - std::exp (-1 / (0.003 * sr));
        susRelease = 1 - std::exp (-1 / (0.15 * sr));
        susSmooth = 1 - std::exp (-1 / (0.01 * sr));
    }

    void process (float* x, int n) noexcept
    {
        const bool off = thresholdDb <= -99;
        const double openAt = std::pow (10.0, thresholdDb / 20.0), closeAt = openAt * 0.5;
        const double ratio = 1 + 5.0 * sustain, maxBoost = 30.0 * sustain;
        for (int i = 0; i < n; ++i)
        {
            const double peak = std::abs (x[i]);
            env = peak > env ? peak : env * envRelease;
            if (env > openAt) { open = true; hold = holdSamples; }
            else if (env < closeAt && hold-- <= 0) open = false;
            const double target = off || open ? 1 : 0;
            gain += (target - gain) * (target > gain ? attack : release);
            double boost = 1;
            if (sustain > 0.001f)
            {
                susEnv += (peak - susEnv) * (peak > susEnv ? susAttack : susRelease);
                const double envDb = 20 * std::log10 (susEnv + 1e-9);
                double db = envDb < -24 ? jmin (maxBoost, (-24 - envDb) * (1 - 1 / ratio)) : 0.0;
                if (envDb < -66) db *= jlimit (0.0, 1.0, (envDb + 80) / 14);
                susGainDb += (db - susGainDb) * susSmooth;
                boost = std::pow (10.0, susGainDb / 20);
            }
            x[i] = (float) (x[i] * gain * boost);
        }
    }
};

//==============================================================================
// Settings for one track's chain, mirroring the song model (see state.js / amp.js).
struct AmpSettings
{
    String model = "off", cab;     // cab: combo112 | open212 | closed412 | bass115 | off | ir
    String irPath;
    float gain = 0.5f, bass = 0.5f, mid = 0.5f, treble = 0.5f, presence = 0.5f, gate = 0.3f, level = 0.5f, sustain = -1;  // -1: the model's default
};

struct TrackSettings
{
    AmpSettings amp;
    var fx;          // the track's character effect (effects.js), or void
    float eqLow = 0, eqMid = 0, eqHigh = 0;
    float tone = 1, drive = 0, volumeDb = -4, pan = 0, reverb = 0, echo = 0;
    bool mute = false;
};

// A track's mixer settings from the song model (state.js track fields; older songs stored the
// cabinet as true/false).
inline TrackSettings parseTrackSettings (const var& t)
{
    TrackSettings s;
    auto num = [&] (const var& o, const char* k, float def) { return o.hasProperty (k) ? (float) (double) o[k] : def; };
    s.eqLow = num (t, "eqLow", 0); s.eqMid = num (t, "eqMid", 0); s.eqHigh = num (t, "eqHigh", 0);
    s.tone = num (t, "tone", 1); s.drive = num (t, "drive", 0); s.volumeDb = num (t, "volume", -4);
    s.pan = num (t, "pan", 0); s.reverb = num (t, "reverb", 0); s.echo = num (t, "echo", 0);
    s.mute = (bool) t.getProperty ("mute", false);
    s.fx = t["fx"];
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

struct ModelInfo { int stages; double g0, g1, tighten, mid, bright, power, level; const char* cab; float sustain; };

inline const ModelInfo* ampModel (const String& id)
{
    static const std::map<String, ModelInfo> models {
        { "clean",   { 1, 1.0,  6.0,   70,  650, 3, 1.2, 1.6,  "open212",   0.0f } },
        { "vintage", { 1, 1.5,  20.0,  70,  600, 4, 1.4, 1.3,  "open212",   0.0f } },
        { "crunch",  { 1, 3.0,  60.0,  90,  800, 2, 1.8, 0.9,  "combo112",  0.35f } },
        { "lead",    { 2, 6.0,  120.0, 130, 700, 1, 2.4, 0.75, "closed412", 0.65f } },
        { "metal",   { 2, 12.0, 300.0, 170, 750, 2, 2.8, 0.6,  "closed412", 0.8f } },
        { "bass",    { 1, 1.0,  18.0,  30,  500, 0, 1.4, 1.2,  "bass115",   0.25f } },
    };
    auto it = models.find (id);
    return it == models.end() ? nullptr : &it->second;
}

struct CabInfo { double low, high; double res[3][3]; };

inline const CabInfo* cabinet (const String& id)
{
    static const std::map<String, CabInfo> cabs {
        { "combo112",  { 80, 5600, { { 120, 1, 3 }, { 2300, 1.4, 4 }, { 650, 1, -2 } } } },
        { "open212",   { 70, 6500, { { 110, 1, 2 }, { 1800, 1.2, 3 }, { 3500, 1.5, 2 } } } },
        { "closed412", { 90, 4800, { { 100, 1.2, 4 }, { 2400, 1.4, 5 }, { 600, 1, -3 } } } },
        { "bass115",   { 40, 3500, { { 80, 1, 3 }, { 800, 1, -2 }, { 2000, 1, 1 } } } },
    };
    auto it = cabs.find (id);
    return it == cabs.end() ? nullptr : &it->second;
}

//==============================================================================
// amp.js AmpSlot: gate -> tighten -> preamp (1 or 2 stages) -> tone stack -> power -> cabinet -> level.
class Amp
{
public:
    void prepare (double sampleRate, int maxBlock)
    {
        rate = sampleRate;
        block = maxBlock;
        gate.prepare (rate);
        shape1.prepare (2, maxBlock);
        shape2.prepare (2, maxBlock);
        power.prepare (1, maxBlock);
        for (auto* s : { &pre1, &pre2, &level, &cabOut, &cabBypass }) s->prepare (rate);
        scratch.setSize (1, maxBlock);
        convolution.prepare ({ rate, (uint32) maxBlock, 1 });
        irKey = {};
        configured = false;
    }

    // Applies settings; rebuilds the curves/filters only when they change. `ir` is the decoded
    // cabinet impulse response for amp.irPath, if one is loaded.
    void configure (const AmpSettings& a, const AudioBuffer<float>* ir)
    {
        model = ampModel (a.model);
        if (model == nullptr) return;
        const auto& m = *model;
        const double drive = m.g0 * std::pow (m.g1 / m.g0, (double) a.gain);
        shape1.curve = tubeCurve (m.stages > 1 ? std::sqrt (drive) * 2 : drive, 0.15);
        shape2.curve = tubeCurve (std::sqrt (drive) * 2.5, 0.08);
        power.curve = tubeCurve (m.power, 0.02);
        const auto db = [] (float v) { return (v - 0.5) * 24.0; };
        tighten.set (Biquad::highpass, m.tighten, 0.7, 0, rate);
        couple.set (Biquad::lowpass, 7000, 0.6, 0, rate);
        bass.set (Biquad::lowshelf, 110, 0.707, db (a.bass), rate);
        mid.set (Biquad::peaking, m.mid, 0.8, db (a.mid), rate);
        treble.set (Biquad::highshelf, 2600, 0.707, db (a.treble) + m.bright, rate);
        presence.set (Biquad::peaking, 4200, 1.2, db (a.presence) * 0.6, rate);
        gate.thresholdDb = a.gate < 0.02f ? -100.0f : -90.0f + a.gate * 60.0f;
        gate.sustain = a.sustain < 0 ? m.sustain : a.sustain;

        // Cabinet: the IR if loaded, else the chosen (or the model's) filter voicing, or none.
        String choice = a.cab.isEmpty() ? String (m.cab) : a.cab;
        if (choice == "ir" && ir == nullptr) choice = m.cab;
        useIr = choice == "ir";
        cabFilters.clear();
        if (useIr)
        {
            if (irKey != a.irPath)
            {
                AudioBuffer<float> copy (1, ir->getNumSamples());
                copy.copyFrom (0, 0, *ir, 0, 0, ir->getNumSamples());
                webAudioNormalise (copy, rate);
                convolution.loadImpulseResponse (std::move (copy), rate, dsp::Convolution::Stereo::no, dsp::Convolution::Trim::no, dsp::Convolution::Normalise::no);
                irKey = a.irPath;
            }
        }
        else if (auto* c = cabinet (choice))
        {
            auto add = [&] (Biquad::Type t, double f, double q, double g) { Biquad b; b.set (t, f, q, g, rate); cabFilters.push_back (b); };
            add (Biquad::highpass, c->low, 0.8, 0);
            for (auto& r : c->res) add (Biquad::peaking, r[0], r[1], r[2]);
            add (Biquad::lowpass, c->high, 0.8, 0);
            add (Biquad::lowpass, c->high, 0.6, 0);
        }
        const bool hasCab = useIr || ! cabFilters.empty();
        pre1.setTarget (m.stages > 1 ? 2.0f : 1.0f, ! configured);
        pre2.setTarget (1.0f, ! configured);
        cabOut.setTarget (hasCab ? 1.0f : 0.0f, ! configured);
        cabBypass.setTarget (hasCab ? 0.0f : 0.6f, ! configured);
        level.setTarget ((float) (m.level * std::pow (10.0, (a.level - 0.5) * 24.0 / 20.0)), ! configured);
        configured = true;
    }

    bool active() const { return model != nullptr; }

    void process (float* x, int n)
    {
        if (model == nullptr) return;
        gate.process (x, n);
        for (int i = 0; i < n; ++i) x[i] = tighten.process (x[i]) * pre1.next();
        shape1.process (x, n);
        for (int i = 0; i < n; ++i) x[i] = couple.process (x[i]);
        if (model->stages > 1)
        {
            for (int i = 0; i < n; ++i) x[i] *= pre2.next();
            shape2.process (x, n);
        }
        for (int i = 0; i < n; ++i) x[i] = presence.process (treble.process (mid.process (bass.process (x[i]))));
        power.process (x, n);
        auto* c = scratch.getWritePointer (0);
        memcpy (c, x, sizeof (float) * (size_t) n);
        if (useIr)
        {
            float* chans[] = { c };
            dsp::AudioBlock<float> b (chans, 1, (size_t) n);
            convolution.process (dsp::ProcessContextReplacing<float> (b));
        }
        else
            for (auto& f : cabFilters)
                for (int i = 0; i < n; ++i) c[i] = f.process (c[i]);
        for (int i = 0; i < n; ++i) x[i] = (c[i] * cabOut.next() + x[i] * cabBypass.next()) * level.next();
    }

private:
    double rate = 48000;
    int block = 512;
    const ModelInfo* model = nullptr;
    bool configured = false, useIr = false;
    String irKey;
    Gate gate;
    Biquad tighten, couple, bass, mid, treble, presence;
    Shaper shape1, shape2, power;
    Smoothed pre1, pre2, level, cabOut, cabBypass;
    std::vector<Biquad> cabFilters;
    dsp::Convolution convolution { dsp::Convolution::Latency { 0 } };
    AudioBuffer<float> scratch;
};

} // namespace bb

#include "TrackFx.h"

namespace bb
{

//==============================================================================
// engine.js TrackNode, from the amp to the sends: amp -> EQ -> tone -> drive -> volume/pan.
// Input is mono (the guitar); output is stereo, plus the reverb and echo send levels.
class TrackChain
{
public:
    void prepare (double sampleRate, int maxBlock)
    {
        rate = sampleRate;
        amp.prepare (rate, maxBlock);
        for (auto& d : driveShaper) d.prepare (0, maxBlock);
        for (auto* s : { &volume, &panL, &panR, &dry, &wet, &reverbSend, &echoSend }) s->prepare (rate, 0.015);
        bufL.setSize (1, maxBlock); bufR.setSize (1, maxBlock);
        fx.prepare (rate);
        configured = false;
    }

    void configure (const TrackSettings& t, const AudioBuffer<float>* ir)
    {
        amp.configure (t.amp, ir);
        for (int c = 0; c < 2; ++c)
        {
            eq[0][c].set (Biquad::lowshelf, 120, 1, t.eqLow, rate);
            eq[1][c].set (Biquad::peaking, 1000, 0.7, t.eqMid, rate);
            eq[2][c].set (Biquad::highshelf, 5000, 1, t.eqHigh, rate);
            tone[c].set (Biquad::lowpass, 400 * std::pow (50.0, (double) t.tone), 1, 0, rate);
            driveShaper[c].curve = distortionCurve (0.1 + 0.75 * t.drive);
        }
        const double w = jmin (1.0, (double) t.drive * 2);
        const bool jump = ! configured;
        dry.setTarget ((float) std::cos (w * MathConstants<double>::halfPi), jump);
        wet.setTarget ((float) std::sin (w * MathConstants<double>::halfPi), jump);
        volume.setTarget (t.mute ? 0.0f : Decibels::decibelsToGain (t.volumeDb, -100.0f), jump);
        // Tone.Channel's panner: mono in, equal-power pan.
        const double x = (jlimit (-1.0f, 1.0f, t.pan) + 1) / 2;
        panL.setTarget ((float) std::cos (x * MathConstants<double>::halfPi), jump);
        panR.setTarget ((float) std::sin (x * MathConstants<double>::halfPi), jump);
        reverbSend.setTarget ((float) std::pow (jmax (0.0f, t.reverb), 1.5f), jump);
        echoSend.setTarget (jmax (0.0f, t.echo) * 0.7f, jump);
        fx.configure (t.fx);
        configured = true;
    }

    // Noise layers in the track's effect (crackle, hiss) only sound while the song plays.
    void setRunning (bool on) { fx.setRunning (on); }

    // Automation (engine.js autoTarget): sets a param's value now, in the param's own units —
    // volume as a gain, pan, the send gains, tone as a frequency in Hz, EQ bands in dB.
    enum class Param { volume, pan, reverb, echo, tone, eqLow, eqMid, eqHigh };
    void automate (Param p, double v)
    {
        switch (p)
        {
            case Param::volume: volume.setTarget ((float) v, true); break;
            case Param::pan:
            {
                const double x = (jlimit (-1.0, 1.0, v) + 1) / 2;
                panL.setTarget ((float) std::cos (x * MathConstants<double>::halfPi), true);
                panR.setTarget ((float) std::sin (x * MathConstants<double>::halfPi), true);
                break;
            }
            case Param::reverb: reverbSend.setTarget ((float) v, true); break;
            case Param::echo: echoSend.setTarget ((float) v, true); break;
            case Param::tone: for (auto& t : tone) t.set (Biquad::lowpass, v, 1, 0, rate); break;
            case Param::eqLow: for (auto& f : eq[0]) f.set (Biquad::lowshelf, 120, 1, v, rate); break;
            case Param::eqMid: for (auto& f : eq[1]) f.set (Biquad::peaking, 1000, 0.7, v, rate); break;
            case Param::eqHigh: for (auto& f : eq[2]) f.set (Biquad::highshelf, 5000, 1, v, rate); break;
        }
    }

    // Stereo in, as the app's track runs (n samples): amp, EQ, tone, drive and effect work on each
    // side, then Tone.Channel takes the track to mono and pans it. With an amp on, only the left
    // side goes on (the amp's gate worklet has one output channel). Adds to out and the send buses.
    void process (const float* inL, const float* inR, int n, float* outL, float* outR, float* revL, float* revR, float* echoL, float* echoR)
    {
        auto* a = bufL.getWritePointer (0);
        auto* b = bufR.getWritePointer (0);
        memcpy (a, inL, sizeof (float) * (size_t) n);
        if (amp.active())
        {
            amp.process (a, n);
            memcpy (b, a, sizeof (float) * (size_t) n);
        }
        else
            memcpy (b, inR, sizeof (float) * (size_t) n);
        float* ch[] = { a, b };
        for (int i = 0; i < n; ++i)
        {
            const float d = dry.next(), w = wet.next();
            for (int c = 0; c < 2; ++c)
            {
                const float s = tone[c].process (eq[2][c].process (eq[1][c].process (eq[0][c].process (ch[c][i]))));
                ch[c][i] = s * d + driveShaper[c].lookup (s) * w;
            }
        }
        if (fx.active()) fx.process (a, b, n);
        for (int i = 0; i < n; ++i)
        {
            const float s = 0.5f * (a[i] + b[i]) * volume.next();
            const float l = s * panL.next(), r = s * panR.next();
            const float rs = reverbSend.next(), es = echoSend.next();
            outL[i] += l; outR[i] += r;
            revL[i] += l * rs; revR[i] += r * rs;
            echoL[i] += l * es; echoR[i] += r * es;
        }
    }

    // A mono source (the live input): the same on both sides.
    void process (const float* in, int n, float* outL, float* outR, float* revL, float* revR, float* echoL, float* echoR)
    {
        process (in, in, n, outL, outR, revL, revR, echoL, echoR);
    }

    Amp amp;

private:
    double rate = 48000;
    bool configured = false;
    Biquad eq[3][2], tone[2];
    Shaper driveShaper[2];
    Smoothed volume, panL, panR, dry, wet, reverbSend, echoSend;
    AudioBuffer<float> bufL, bufR;
    FxSlot fx;
};

//==============================================================================
// buildBuses(): the room reverb and the tempo echo the tracks send to.
class SendEffects
{
public:
    void prepare (double sampleRate, int maxBlock)
    {
        rate = sampleRate;
        for (auto& f : reverbEq) f.set (Biquad::highpass, 220, 1, 0, rate);
        for (auto& f : echoTone) f.set (Biquad::lowpass, 3200, 1, 0, rate);
        reverb.loadImpulseResponse (makeImpulse (2.6), rate, dsp::Convolution::Stereo::yes, dsp::Convolution::Trim::no, dsp::Convolution::Normalise::no);
        reverb.prepare ({ rate, (uint32) maxBlock, 2 });
        for (auto& e : echo) { e.prepare ((int) (rate * 4)); e.feedback = 0.32f; }
        setTempo (120);
    }

    void setTempo (double bpm) { for (auto& e : echo) e.setDelay ((int) std::lround (60.0 / bpm * 0.75 * rate)); }

    // Processes the send buses in place and adds the results to out.
    void process (float* revL, float* revR, float* echoL, float* echoR, float* outL, float* outR, int n)
    {
        for (int i = 0; i < n; ++i) { revL[i] = reverbEq[0].process (revL[i]); revR[i] = reverbEq[1].process (revR[i]); }
        float* chans[] = { revL, revR };
        dsp::AudioBlock<float> b (chans, 2, (size_t) n);
        reverb.process (dsp::ProcessContextReplacing<float> (b));
        for (int i = 0; i < n; ++i)
        {
            float* ins[] = { echoL, echoR };
            for (int c = 0; c < 2; ++c)
                ins[c][i] = echoTone[c].process (echo[c].process (ins[c][i]));   // Tone.FeedbackDelay, wet 1
            outL[i] += revL[i] + echoL[i];
            outR[i] += revR[i] + echoR[i];
        }
    }

private:
    double rate = 48000;
    Biquad reverbEq[2], echoTone[2];
    dsp::Convolution reverb { dsp::Convolution::Latency { 0 } };
    WebFeedbackDelay echo[2];

    // engine.js makeImpulse(): smooth stereo room, darker as it fades; scaled the way Web Audio's
    // ConvolverNode normalises (so the reverb level matches).
    AudioBuffer<float> makeImpulse (double seconds)
    {
        const int len = (int) (rate * seconds);
        AudioBuffer<float> b (2, len);
        std::mt19937 rng (1234);
        std::uniform_real_distribution<float> noise (-1.0f, 1.0f);
        for (int c = 0; c < 2; ++c)
        {
            auto* d = b.getWritePointer (c);
            double lp = 0;
            for (int i = 0; i < len; ++i)
            {
                const double t = (double) i / len;
                const double k = 0.15 + 0.8 * (1 - t);
                lp += k * (noise (rng) - lp);
                const double pre = i < rate * 0.012 ? 0 : 1;
                d[i] = (float) (lp * std::pow (1 - t, 2.8) * pre);
            }
        }
        webAudioNormalise (b, rate);
        return b;
    }
};

//==============================================================================
// master-worklet.js: glue compressor and a 1 ms lookahead limiter.
class MasterBus
{
public:
    void prepare (double sr)
    {
        att = std::exp (-1 / (0.012 * sr));
        rel = std::exp (-1 / (0.2 * sr));
        look = jmax (1, (int) std::lround (0.001 * sr));
        limRel = std::exp (-1 / (0.06 * sr));
        bufL.assign ((size_t) look + 1, 0); bufR.assign ((size_t) look + 1, 0); need.assign ((size_t) look + 1, 1);
        w = 0; det = 0; limGain = 1;
        volume.prepare (sr);
        volume.setTarget (1.0f, true);
        fx.prepare (sr);
    }

    void setVolumeDb (float db) { volume.setTarget (Decibels::decibelsToGain (db, -100.0f)); }

    // Master FX (effects.js FxSlot on the master bus), between the volume and the dynamics.
    FxSlot fx;

    void process (float* l, float* r, int n) noexcept
    {
        const int size = look + 1;
        if (fx.active())
        {
            for (int i = 0; i < n; ++i) { const float v = volume.next(); l[i] *= v; r[i] *= v; }
            fx.process (l, r, n);
        }
        for (int i = 0; i < n; ++i)
        {
            const float v = fx.active() ? 1.0f : volume.next();
            const float inL = l[i] * v, inR = r[i] * v;
            const double peak = jmax (std::abs (inL), std::abs (inR));
            det = peak > det ? att * det + (1 - att) * peak : rel * det + (1 - rel) * peak;
            const double g = std::pow (10.0, compGainDb (20 * std::log10 (det + 1e-9)) / 20);
            const float cl = (float) (inL * g), cr = (float) (inR * g);
            bufL[(size_t) w] = cl; bufR[(size_t) w] = cr;
            const double p = jmax (std::abs (cl), std::abs (cr));
            need[(size_t) w] = p > ceil ? ceil / p : 1;
            w = (w + 1) % size;
            double target = 1;
            for (auto v2 : need) target = jmin (target, v2);
            limGain = target < limGain ? target : limRel * limGain + (1 - limRel) * target;
            l[i] = (float) (bufL[(size_t) w] * limGain);
            r[i] = (float) (bufR[(size_t) w] * limGain);
        }
    }

private:
    double att = 0, rel = 0, limRel = 0, det = 0, limGain = 1;
    const double ceil = std::pow (10.0, -0.8 / 20), thr = -16, ratio = 2.5, knee = 8;
    int look = 1, w = 0;
    std::vector<float> bufL, bufR;
    std::vector<double> need;
    Smoothed volume;

    double compGainDb (double levelDb) const
    {
        const double over = levelDb - thr, k = knee / 2;
        if (over <= -k) return 0;
        const double slope = 1 - 1 / ratio;
        if (over >= k) return -over * slope;
        return -slope * (over + k) * (over + k) / (2 * knee);
    }
};

} // namespace bb
