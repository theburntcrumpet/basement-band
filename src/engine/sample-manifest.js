// The bundled sample library layout. Shared by scripts/fetch-samples.mjs and the instrument loader.

export const INSTRUMENT_NOTES = {
  'bass-electric': 'As1 As2 As3 As4 Cs1 Cs2 Cs3 Cs4 Cs5 E1 E2 E3 E4 G1 G2 G3 G4',
  bassoon: 'A2 A3 A4 C3 C4 C5 E4 G2 G3 G4',
  cello: 'A2 A3 A4 As2 As3 B2 B3 B4 C2 C3 C4 C5 Cs3 Cs4 D2 D3 D4 Ds2 Ds3 Ds4 E2 E3 E4 F2 F3 F4 Fs3 Fs4 G2 G3 G4 Gs2 Gs3 Gs4',
  clarinet: 'As3 As4 As5 D3 D4 D5 D6 F3 F4 F5 Fs6',
  contrabass: 'A2 As1 B3 C2 Cs3 D2 E2 E3 Fs1 Fs2 G1 Gs2 Gs3',
  flute: 'A4 A5 A6 C4 C5 C6 C7 E4 E5 E6',
  'french-horn': 'A1 A3 C2 C4 D3 D5 Ds2 F3 F5 G2',
  'guitar-acoustic': 'A2 A3 A4 As2 As3 As4 B2 B3 B4 C3 C4 C5 Cs3 Cs4 Cs5 D2 D3 D4 D5 Ds2 Ds3 Ds4 E2 E3 E4 F2 F3 F4 Fs2 Fs3 Fs4 G2 G3 G4 Gs2 Gs3 Gs4',
  'guitar-electric': 'A2 A3 A4 A5 C3 C4 C5 C6 Cs2 Ds3 Ds4 Ds5 E2 Fs2 Fs3 Fs4 Fs5',
  'guitar-nylon': 'A2 A3 A4 A5 As5 B1 B2 B3 B4 Cs3 Cs4 Cs5 D2 D3 D5 Ds4 E2 E3 E4 E5 Fs2 Fs3 Fs4 Fs5 G3 G5 Gs2 Gs4 Gs5',
  harmonium: 'A2 A3 A4 As2 As3 As4 B2 B3 B4 C2 C3 C4 C5 Cs2 Cs3 Cs4 Cs5 D2 D3 D4 D5 Ds2 Ds3 Ds4 E2 E3 E4 F2 F3 F4 Fs2 Fs3 G2 G3 G4 Gs2 Gs3 Gs4',
  harp: 'A2 A4 A6 B1 B3 B5 B6 C3 C5 D2 D4 D6 D7 E1 E3 E5 F2 F4 F6 F7 G1 G3 G5',
  organ: 'A1 A2 A3 A4 A5 C1 C2 C3 C4 C5 C6 Ds1 Ds2 Ds3 Ds4 Ds5 Fs1 Fs2 Fs3 Fs4 Fs5',
  saxophone: 'A4 A5 As3 As4 B3 B4 C4 C5 Cs3 Cs4 Cs5 D3 D4 D5 Ds3 Ds4 Ds5 E3 E4 E5 F3 F4 F5 Fs3 Fs4 Fs5 G3 G4 G5 Gs3 Gs4 Gs5',
  trombone: 'As1 As2 As3 C3 C4 Cs2 Cs4 D3 D4 Ds2 Ds3 Ds4 F2 F3 F4 Gs2 Gs3',
  trumpet: 'A3 A5 As4 C4 C6 D5 Ds4 F3 F4 F5 G4',
  tuba: 'As1 As2 As3 D3 D4 Ds2 F1 F2 F3',
  violin: 'A3 A4 A5 A6 C4 C5 C6 C7 E4 E5 E6 G3 G4 G5 G6',
  xylophone: 'C5 C6 C7 C8 G4 G5 G6 G7',
};

// Salamander grand: every minor third from A0 to C8.
export const PIANO_NOTES = ['A0'];
for (let o = 1; o <= 7; o++) PIANO_NOTES.push(`C${o}`, `Ds${o}`, `Fs${o}`, `A${o}`);
PIANO_NOTES.push('C8');

export const VELOCITY_LAYERS = ['Softest', 'Soft', 'Med', 'Hard', 'Hardest'];
export const ROCK_PIECES = ['Kick', 'SideStick', 'Snare', 'SnareRimshot', 'TomFloor', 'Tom1', 'Tom2',
  'HatClosed', 'HatPedal', 'HatSemiOpen', 'HatOpen', 'Ride', 'Bell', 'Crash', 'Splash', 'Cowbell'];
export const ROCK_FILES = [...ROCK_PIECES.flatMap(p => VELOCITY_LAYERS.map(l => `${p}-${l}.wav`)), 'HandClap.wav'];
export const TR808_NAMES = ['808_Kick_Long', '808_Kick_Short', '808_Snare_1', '808_Snare_2', '808_Clap',
  '808_Tom_Low', '808_Tom_Mid', '808_Tom_Hi', '808_Hat_Closed', '808_Hat_Pedal', '808_Hat_Open',
  '808_Cymbal', '808_Shaker', '808_Conga', '808_Clave', '808_Cowbell'];
export const TR808_FILES = TR808_NAMES.map(f => f + '.flac');

// Field recordings and effects from Freesound, all CC0 1.0 (verified on each sound's page).
// Files are Freesound's high-quality previews. Credits are written to CREDITS.md.
export const FREESOUND_FX = [
  { group: "Waves", name: "Ocean Waves", file: 'fx/ocean-waves-531015.mp3', url: "https://cdn.freesound.org/previews/531/531015_9818404-hq.mp3", author: "Noted451", page: 'https://freesound.org/s/531015/' },
  { group: "Waves", name: "Calm Waves on a Beach", file: 'fx/calm-waves-on-a-beach-218387.mp3', url: "https://cdn.freesound.org/previews/218/218387_3299593-hq.mp3", author: "Motion_S", page: 'https://freesound.org/s/218387/' },
  { group: "Waves", name: "Waves Crashing on Rocks", file: 'fx/waves-crashing-on-rocks-376801.mp3', url: "https://cdn.freesound.org/previews/376/376801_6128004-hq.mp3", author: "amholma", page: 'https://freesound.org/s/376801/' },
  { group: "Waves", name: "Underwater", file: 'fx/underwater-504641.mp3', url: "https://cdn.freesound.org/previews/504/504641_9395330-hq.mp3", author: "Fission9", page: 'https://freesound.org/s/504641/' },
  { group: "Wind", name: "Autumn Wind & Leaves", file: 'fx/autumn-wind-and-leaves-457318.mp3', url: "https://cdn.freesound.org/previews/457/457318_9065275-hq.mp3", author: "Stek59", page: 'https://freesound.org/s/457318/' },
  { group: "Wind", name: "Arctic Wind", file: 'fx/arctic-wind-117136.mp3', url: "https://cdn.freesound.org/previews/117/117136_732072-hq.mp3", author: "cobratronik", page: 'https://freesound.org/s/117136/' },
  { group: "Wind", name: "Strong Wind", file: 'fx/strong-wind-459981.mp3', url: "https://cdn.freesound.org/previews/459/459981_6253486-hq.mp3", author: "florianreichelt", page: 'https://freesound.org/s/459981/' },
  { group: "Rain & Thunder", name: "Rain & Thunder", file: 'fx/rain-and-thunder-237729.mp3', url: "https://cdn.freesound.org/previews/237/237729_3839718-hq.mp3", author: "FlatHill", page: 'https://freesound.org/s/237729/' },
  { group: "Rain & Thunder", name: "Rain", file: 'fx/rain-265627.mp3', url: "https://cdn.freesound.org/previews/265/265627_2246924-hq.mp3", author: "director89", page: 'https://freesound.org/s/265627/' },
  { group: "Rain & Thunder", name: "Thunder Blast", file: 'fx/thunder-blast-399656.mp3', url: "https://cdn.freesound.org/previews/399/399656_2341984-hq.mp3", author: "bajko", page: 'https://freesound.org/s/399656/' },
  { group: "Rain & Thunder", name: "Lightning Strike", file: 'fx/lightning-strike-74892.mp3', url: "https://cdn.freesound.org/previews/74/74892_1149857-hq.mp3", author: "parnellij", page: 'https://freesound.org/s/74892/' },
  { group: "Nature", name: "Birdsong", file: 'fx/birdsong-34180.mp3', url: "https://cdn.freesound.org/previews/34/34180_25449-hq.mp3", author: "Dalibor", page: 'https://freesound.org/s/34180/' },
  { group: "Nature", name: "Jungle Birds & Insects", file: 'fx/jungle-birds-and-insects-423711.mp3', url: "https://cdn.freesound.org/previews/423/423711_1451873-hq.mp3", author: "myrinvp", page: 'https://freesound.org/s/423711/' },
  { group: "Nature", name: "River Stream", file: 'fx/river-stream-433589.mp3', url: "https://cdn.freesound.org/previews/433/433589_5618682-hq.mp3", author: "jackthemurray", page: 'https://freesound.org/s/433589/' },
  { group: "Nature", name: "Running Water", file: 'fx/running-water-415151.mp3', url: "https://cdn.freesound.org/previews/415/415151_7241289-hq.mp3", author: "BurghRecords", page: 'https://freesound.org/s/415151/' },
  { group: "Crowd", name: "Roaring Crowd", file: 'fx/roaring-crowd-130568.mp3', url: "https://cdn.freesound.org/previews/130/130568_2024417-hq.mp3", author: "benfree", page: 'https://freesound.org/s/130568/' },
  { group: "Crowd", name: "Crowd Cheering", file: 'fx/crowd-cheering-365132.mp3', url: "https://cdn.freesound.org/previews/365/365132_3279490-hq.mp3", author: "SoundsExciting", page: 'https://freesound.org/s/365132/' },
  { group: "Crowd", name: "Cheering & Clapping", file: 'fx/cheering-and-clapping-221567.mp3', url: "https://cdn.freesound.org/previews/221/221567_1282865-hq.mp3", author: "AlaskaRobotics", page: 'https://freesound.org/s/221567/' },
  { group: "Fire & Vinyl", name: "Fire Crackles", file: 'fx/fire-crackles-508110.mp3', url: "https://cdn.freesound.org/previews/508/508110_6657854-hq.mp3", author: "ahriik", page: 'https://freesound.org/s/508110/' },
  { group: "Fire & Vinyl", name: "Bonfire", file: 'fx/bonfire-364992.mp3', url: "https://cdn.freesound.org/previews/364/364992_4351264-hq.mp3", author: "forfie", page: 'https://freesound.org/s/364992/' },
  { group: "Fire & Vinyl", name: "Vinyl Crackle", file: 'fx/vinyl-crackle-130393.mp3', url: "https://cdn.freesound.org/previews/130/130393_1220006-hq.mp3", author: "veezay", page: 'https://freesound.org/s/130393/' },
  { group: "Fire & Vinyl", name: "Vinyl Dust", file: 'fx/vinyl-dust-614342.mp3', url: "https://cdn.freesound.org/previews/614/614342_1282624-hq.mp3", author: "mitchanary", page: 'https://freesound.org/s/614342/' },
  { group: "City", name: "Shopping Street", file: 'fx/shopping-street-451734.mp3', url: "https://cdn.freesound.org/previews/451/451734_6253486-hq.mp3", author: "florianreichelt", page: 'https://freesound.org/s/451734/' },
  { group: "City", name: "City Traffic", file: 'fx/city-traffic-512142.mp3', url: "https://cdn.freesound.org/previews/512/512142_2286319-hq.mp3", author: "lupalenzuela", page: 'https://freesound.org/s/512142/' },
  { group: "Whooshes", name: "Whoosh", file: 'fx/whoosh-60013.mp3', url: "https://cdn.freesound.org/previews/60/60013_71257-hq.mp3", author: "qubodup", page: 'https://freesound.org/s/60013/' },
  { group: "Whooshes", name: "Quick Woosh", file: 'fx/quick-woosh-683101.mp3', url: "https://cdn.freesound.org/previews/683/683101_6253486-hq.mp3", author: "florianreichelt", page: 'https://freesound.org/s/683101/' },
  { group: "Whooshes", name: "Soft Woosh", file: 'fx/soft-woosh-243400.mp3', url: "https://cdn.freesound.org/previews/243/243400_4146245-hq.mp3", author: "freakinbehemoth", page: 'https://freesound.org/s/243400/' },
  { group: "Whooshes", name: "Double Swoosh", file: 'fx/double-swoosh-19312.mp3', url: "https://cdn.freesound.org/previews/19/19312_84709-hq.mp3", author: "martian", page: 'https://freesound.org/s/19312/' },
  { group: "Whooshes", name: "Space Swoosh", file: 'fx/space-swoosh-220191.mp3', url: "https://cdn.freesound.org/previews/220/220191_4100837-hq.mp3", author: "GameAudio", page: 'https://freesound.org/s/220191/' },
  { group: "Whooshes", name: "Reverse Breath Whoosh", file: 'fx/reverse-breath-whoosh-181889.mp3', url: "https://cdn.freesound.org/previews/181/181889_3386153-hq.mp3", author: "PrdiChlp", page: 'https://freesound.org/s/181889/' },
  { group: "Hits & Drops", name: "Cinematic Hit", file: 'fx/cinematic-hit-427803.mp3', url: "https://cdn.freesound.org/previews/427/427803_2866779-hq.mp3", author: "DeVern", page: 'https://freesound.org/s/427803/' },
  { group: "Hits & Drops", name: "Sub Drop", file: 'fx/sub-drop-428073.mp3', url: "https://cdn.freesound.org/previews/428/428073_4067257-hq.mp3", author: "newagesoup", page: 'https://freesound.org/s/428073/' },
  { group: "Hits & Drops", name: "Distant Explosion", file: 'fx/distant-explosion-149966.mp3', url: "https://cdn.freesound.org/previews/149/149966_2514850-hq.mp3", author: "NenadSimic", page: 'https://freesound.org/s/149966/' },
  { group: "Hits & Drops", name: "Metal Boom", file: 'fx/metal-boom-209772.mp3', url: "https://cdn.freesound.org/previews/209/209772_2012390-hq.mp3", author: "Johnnyfarmer", page: 'https://freesound.org/s/209772/' },
];

// From Sonic Pi's sample set (each originally from Freesound, CC0 1.0).
export const SONICPI_FX = [
  { group: "Whooshes", name: "Swoosh (Sonic Pi)", file: 'fx/sonicpi-perc_swoosh.flac', url: 'https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/samples/perc_swoosh.flac', author: 'Sonic Pi (via Freesound)', page: 'https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md' },
  { group: "Whooshes", name: "Dark Woosh", file: 'fx/sonicpi-ambi_dark_woosh.flac', url: 'https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/samples/ambi_dark_woosh.flac', author: 'Sonic Pi (via Freesound)', page: 'https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md' },
  { group: "Hits & Drops", name: "808-style Boom", file: 'fx/sonicpi-bd_boom.flac', url: 'https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/samples/bd_boom.flac', author: 'Sonic Pi (via Freesound)', page: 'https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md' },
  { group: "Hits & Drops", name: "Cinematic Boom", file: 'fx/sonicpi-misc_cineboom.flac', url: 'https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/samples/misc_cineboom.flac', author: 'Sonic Pi (via Freesound)', page: 'https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md' },
  { group: "Drones & Pads", name: "Drone", file: 'fx/sonicpi-ambi_drone.flac', url: 'https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/samples/ambi_drone.flac', author: 'Sonic Pi (via Freesound)', page: 'https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md' },
  { group: "Drones & Pads", name: "Glass Hum", file: 'fx/sonicpi-ambi_glass_hum.flac', url: 'https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/samples/ambi_glass_hum.flac', author: 'Sonic Pi (via Freesound)', page: 'https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md' },
  { group: "Drones & Pads", name: "Glass Rub", file: 'fx/sonicpi-ambi_glass_rub.flac', url: 'https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/samples/ambi_glass_rub.flac', author: 'Sonic Pi (via Freesound)', page: 'https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md' },
  { group: "Drones & Pads", name: "Haunted Hum", file: 'fx/sonicpi-ambi_haunted_hum.flac', url: 'https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/samples/ambi_haunted_hum.flac', author: 'Sonic Pi (via Freesound)', page: 'https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md' },
  { group: "Drones & Pads", name: "Lunar Landscape", file: 'fx/sonicpi-ambi_lunar_land.flac', url: 'https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/samples/ambi_lunar_land.flac', author: 'Sonic Pi (via Freesound)', page: 'https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md' },
  { group: "Drones & Pads", name: "Choir Pad", file: 'fx/sonicpi-ambi_choir.flac', url: 'https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/samples/ambi_choir.flac', author: 'Sonic Pi (via Freesound)', page: 'https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md' },
  { group: "Drones & Pads", name: "Soft Buzz", file: 'fx/sonicpi-ambi_soft_buzz.flac', url: 'https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/samples/ambi_soft_buzz.flac', author: 'Sonic Pi (via Freesound)', page: 'https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md' },
];

// CC0 instruments from the Versilian libraries, pinned to a commit so the library can't shift under us.
// The fetch script converts them to 16-bit FLAC. `path` is the upstream file with {n} for its note name;
// `alt` lists notes with a different ending. `shift` turns the upstream octave numbers into scientific
// pitch (middle C = C4); each one comes from measuring the samples' actual pitch, since most upstream
// names are an octave low. The top kalimba tine (B4) is left out: it's mostly sympathetic ringing.
export const VERSILIAN = {
  vcsl: { name: 'Versilian Community Sample Library', url: 'https://github.com/sgossner/VCSL', raw: 'https://raw.githubusercontent.com/sgossner/VCSL/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e/' },
  vsco: { name: 'VSCO 2 Community Edition', url: 'https://github.com/sgossner/VSCO-2-CE', raw: 'https://raw.githubusercontent.com/sgossner/VSCO-2-CE/440300901dfe9275fd84e0b7763af1f8443ae62e/' },
};

export const CC0_INSTRUMENTS = {
  "harpsichord": { repo: 'vcsl', path: "Chordophones/Zithers/Harpsichord, French/Sustains/Harpsi2_Normal_{n}_rr1_Main.wav", notes: 'D0 G#0 C1 E1 G#1 C2 E2 G#2 C3 E3 G#3 C4 E4 G#4 C5', stereo: true, shift: 1 },
  "harpsichord-flemish": { repo: 'vcsl', path: "Chordophones/Zithers/Harpsichord, Flemish/Sustains/High/HarpsiRH_High_Far_{n}_rr1.wav", notes: 'F#1 A#1 C#2 E2 G#2 C#3 E3 G#3 C#4 E4 G#4 C5 E5 G#5 C6', stereo: true, shift: 1 },
  "upright-piano": { repo: 'vcsl', path: "Chordophones/Zithers/Upright Piano, Yamaha/Sustains/Upright1_Sus_{n}_vl2_rr1.wav", notes: 'C0 G0 C1 G1 C2 G2 C3 G3 C4 G4 C5 G5 C6', stereo: true, shift: 1 },
  "fm-piano": { repo: 'vcsl', path: "Electrophones/TX81Z/FM Piano/FMPiano_{n}_vl2.wav", notes: 'C0 G#0 E1 C2 G#2 E3 C4 G#4 E5 C6 G#6 C7', shift: 0 },
  "clavisynth": { repo: 'vcsl', path: "Electrophones/TX81Z/Clavisynth/Clavisynth_{n}_vl2.wav", notes: 'C0 G#0 E1 C2 G#2 E3 C4 G#4 E5 C6', shift: 2 },
  "marimba": { repo: 'vcsl', path: "Idiophones/Struck Idiophones/Marimba/Marimba_hit_Outrigger_{n}_loud_01.wav", notes: 'F1 C2 G2 B2 F3 C4 G4 B4 F5 C6', stereo: true, shift: 1 },
  "vibraphone": { repo: 'vcsl', path: "Idiophones/Struck Idiophones/Vibraphone/Soft Mallets/Vibes_soft_{n}_v2_rr1_Main.wav", notes: 'F2 A2 C3 E3 G3 B3 D4 F4 A4 C5 E5', stereo: true, shift: 1 },
  "glockenspiel": { repo: 'vcsl', path: "Idiophones/Struck Idiophones/Glockenspiel/glock_medium_{n}_01.wav", notes: 'G4 C5 G5 C6 G6 C7', shift: 1 },
  "tubular-bells": { repo: 'vcsl', path: "Idiophones/Struck Idiophones/Tubular Bells 1/chimes_{n}_ff_rr2.wav", notes: 'C3 D3 E3 F#3 G#3 A#3 C4 D4 E4', alt: {"C3": "_f_rr1.wav", "D3": "_ff_rr1.wav", "F#3": "_fff_rr1.wav", "G#3": "_ff_rr1.wav", "A#3": "_ff_rr1.wav"}, stereo: true, shift: 2 },
  "hand-chimes": { repo: 'vcsl', path: "Idiophones/Struck Idiophones/Hand Chimes/sus_{n}_r01_main.wav", notes: 'C3 E3 G#3 C4 E4 G#4 C5 E5 G#5 C6', stereo: true, shift: 1 },
  "kalimba": { repo: 'vcsl', path: "Idiophones/Plucked Idiophones/Kalimba, Kenya/Mbira6_Normal_MainSpirit_{n}_k8_vl3_rr2.wav", notes: 'B2 C#3 D#3 F#3 G#3 B3 C#4 D#4 F#4 A4', alt: {"C#3": "_k7_vl3_rr2.wav", "D#3": "_k6_vl3_rr2.wav", "F#3": "_k10_vl3_rr2.wav", "G#3": "_k11_vl3_rr2.wav", "B3": "_k12_vl3_rr2.wav", "C#4": "_k2_vl3_rr2.wav", "D#4": "_k13_vl3_rr2.wav", "F#4": "_k14_vl3_rr2.wav", "A4": "_k1_vl3_rr2.wav", "B4": "_k15_vl3_rr2.wav"}, shift: 1 },
  "recorder": { repo: 'vcsl', path: "Aerophones/Edge-blown Aerophones/Baroque Alto Recorder/Sustain/AltRecorder_Sus_{n}_rr1_Main.wav", notes: 'F3 G#3 C4 E4 G#4 C5 E5', shift: 1 },
  "ocarina": { repo: 'vcsl', path: "Aerophones/Edge-blown Aerophones/Ocarina, Typical/Sustains/SusVib/StdOcarina_SusVib_{n}.wav", notes: 'A3 C4 D#4 F#4 A4 C5', shift: 1 },
  "harmonica": { repo: 'vcsl', path: "Aerophones/Free Aerophones/Harmonica-Hohner-Super64/Sustains/Normal/Hohner-Super64_Normal _{n}.wav", notes: 'C2 G2 C3 G3 C4 G4 C5 G5 C6', shift: 1 },
  "dan-tranh": { repo: 'vcsl', path: "Chordophones/Zithers/Dan Tranh/Normal/{n}_mf_1.wav", notes: 'B1 D#2 F#2 C#3 F#3 B3 D#4 F#4 B4', stereo: true, shift: 1 },
  "psaltery": { repo: 'vcsl', path: "Chordophones/Zithers/Psaltery, Bowed and Plucked/Pluck/BowedPsaltery_{n}_Main_Pluck_rr1.wav", notes: 'A#3 C4 D4 E4 F#4 G#4 A#4 C5 D5 E5 F#5', alt: {"E4": "_Main_Pluck_rr2.wav", "G#4": "_Main_Pluck_rr3.wav", "F#5": "_Main_Pluck_rr3.wav"}, stereo: true, shift: 1 },
  "folk-harp": { repo: 'vcsl', path: "Chordophones/Composite Chordophones/Folk Harp/EWHarp_Normal_{n}_v2_RR1.wav", notes: 'C1 E1 G#1 C2 E2 G#2 C3 E3 G#3 C4 E4 G#4 C5 E5 G#5', stereo: true, shift: 1 },
  "saxello": { repo: 'vcsl', path: "Aerophones/Reed Aerophones/Saxello/Vibrato/BrettSaxello_SusVB_MainSpirit_{n}_vl2_rr1.wav", notes: 'A#2 D3 F#3 A#3 D4 F#4 A#4 D#5', shift: 1 },
  "violin-section": { repo: 'vsco', path: "Strings/Violin Section/susVib/VlnEns_susVib_{n}_v2.wav", notes: 'G2 B2 D3 F#3 A3 C4 E4 G4 B4 D5', stereo: true, shift: 1 },
  "viola-section": { repo: 'vsco', path: "Strings/Viola Section/susvib/ViolaEns_susvib_{n}_v2_1.wav", notes: 'C2 E2 G2 B2 D3 F3 A3 C4 E4 G4 B4 D5', stereo: true, shift: 1 },
  "cello-section": { repo: 'vsco', path: "Strings/Cello Section/susvib/susvib_{n}_v3_1.wav", notes: 'C1 E1 G1 B1 D2 F2 A2 C3 E3 G3 B3 D4 F4', stereo: true, shift: 1 },
  "contrabass-arco": { repo: 'vsco', path: "Strings/Solo Contrabass/SusVib/BKCtbss_SusVib_{n}_v3_rr1.wav", notes: 'F#0 A#0 D1 F#1 A1 C#2 E2 G#2 B2', shift: 1 },
  "violin-trem": { repo: 'vsco', path: "Strings/Violin Section/Trem/VlnEns_Trem_{n}_v1.wav", notes: 'G2 B2 D3 F#3 A3 C4 E4 G4 B4 D5', stereo: true, shift: 1 },
  "viola-trem": { repo: 'vsco', path: "Strings/Viola Section/trem/Violas_trem_{n}_v2_rr1.wav", notes: 'C2 E2 G2 B2 D3 F3 A3 C4 E4 G4 B4 D5', stereo: true, shift: 1 },
  "cello-trem": { repo: 'vsco', path: "Strings/Cello Section/trem/trem_{n}_v2_1.wav", notes: 'C1 E1 G1 B1 D2 F2 A2 C3 E3 G3 B3 D4 F4', alt: {"B1": "_v1_1.wav"}, stereo: true, shift: 1 },
  "violin-pizz": { repo: 'vsco', path: "Strings/Violin Section/Pizz/VlnEns_Pizz_{n}_v1_rr1.wav", notes: 'G2 B2 D3 F#3 A3 C4 E4 G4 B4 D5', stereo: true, shift: 1 },
  "viola-pizz": { repo: 'vsco', path: "Strings/Viola Section/pizz/ViolaEns_pizz_{n}_v2_rr1.wav", notes: 'C2 E2 G2 B2 D3 F3 A3 C4 E4 G4 B4 D5', alt: {"D5": "_v1_rr1.wav"}, stereo: true, shift: 1 },
  "cello-pizz": { repo: 'vsco', path: "Strings/Cello Section/pizzT/pizzT_{n}_v2_RR1.wav", notes: 'C1 E1 G1 B1 D2 F2 A2 C3 E3 G3 B3 D4 F4', stereo: true, shift: 1 },
  "contrabass-pizz": { repo: 'vsco', path: "Strings/Solo Contrabass/Pizz/BKCtbss_Pizz_{n}_v1_rr1.wav", notes: 'E0 G0 A#0 D1 F#1 A1 C#2 E2 G#2 B2', shift: 1 },
  "violin-spic": { repo: 'vsco', path: "Strings/Violin Section/Spic/VlnEns_Spic_{n}_v1_rr1.wav", notes: 'G2 B2 D3 F#3 A3 C4 E4 G4 B4 D5', stereo: true, shift: 1 },
  "viola-spic": { repo: 'vsco', path: "Strings/Viola Section/spic/Violas_spic_{n}_v2_rr1.wav", notes: 'C2 E2 G2 B2 D3 F3 A3 C4 E4 G4 B4 D5', stereo: true, shift: 1 },
  "cello-spic": { repo: 'vsco', path: "Strings/Cello Section/spic/spic_{n}_v2_RR1.wav", notes: 'C1 E1 G1 B1 D2 F2 A2 C3 E3 G3 B3 D4 F4', stereo: true, shift: 1 },
  "trumpet-vib": { repo: 'vsco', path: "Brass/Trumpet/susvib/Sum_SHTrumpet_susvib_{n}_v1_rr1.wav", notes: 'F2 A2 C3 D#3 G3 A#3 D4 F4 A4 C5', shift: 1 },
  "trumpet-harmon": { repo: 'vsco', path: "Brass/Trumpet/harmonM-sus/Sum_SHTrumpet_harmonM-sus_{n}_v1_rr1.wav", notes: 'A#2 D#3 G#3 D4 F4 A4', shift: 1 },
  "trumpet-straight": { repo: 'vsco', path: "Brass/Trumpet/straightM-sus/Sum_SHTrumpet_straightM-sus_{n}_v1_rr1.wav", notes: 'A#2 D3 G3 A#3 D4 F4 A4', shift: 1 },
  "trumpet-stac": { repo: 'vsco', path: "Brass/Trumpet/stac/Sum_SHTrumpet_stac_{n}_v3_rr1.wav", notes: 'F2 A2 C3 D#3 G3 A#3 D4 F4 A4 C5', shift: 1 },
  "horn-mute": { repo: 'vsco', path: "Brass/F Horn/mute/MOHorn_mute_{n}_v2_1.wav", notes: 'A#1 D#2 C3 D#3 G#3 D4 F4', alt: {"C3": "_v3_1.wav", "D4": "_v1_1.wav", "F4": "_v1_1.wav"}, shift: 1 },
  "horn-stac": { repo: 'vsco', path: "Brass/F Horn/stac/MOHorn_stac_{n}_v3_rr1.wav", notes: 'A0 C1 D#1 G1 A#1 D2 F2 A2 C3 D4 F4', alt: {"A0": "_v1_rr1.wav", "C1": "_v2_rr1.wav", "D#1": "_v2_rr1.wav", "G1": "_v2_rr1.wav"}, shift: 1 },
  "trombone-vib": { repo: 'vsco', path: "Brass/Tenor Trombone/vib/tenortbn_vib_{n}_v1_1.wav", notes: 'F1 G#1 C2 D#2 G#2 C3 D#3', shift: 1 },
  "trombone-stac": { repo: 'vsco', path: "Brass/Tenor Trombone/stac/tenortbn_stac_{n}_v3_rr1.wav", notes: 'A#0 F1 A#1 F2 A#2 D3 F3', shift: 1 },
  "tuba-stac": { repo: 'vsco', path: "Brass/Tuba/stac/Tuba3_stac_{n}_v2_rr1_Sum.wav", notes: 'A#0 D#1 A#1 D2 F2 A#2 D3', shift: 1 },
  "oboe": { repo: 'vsco', path: "Woodwinds/Oboe/Vib/Oboe_Vib_{n}_v1_Main.wav", notes: 'A#2 D3 F3 A#3 D4 F4 A#4 D5 F5', shift: 1 },
  "piccolo": { repo: 'vsco', path: "Woodwinds/Piccolo/Sus/piccolo_{n}_sustain1.wav", notes: 'G4 C5 G5 C6 G6', shift: 1 },
};

// Percussion one-shots for the sample browser (VCSL, CC0).
export const CC0_PERCUSSION = [
  { group: 'Percussion', name: "Conga, Open", file: "perc/conga-open.flac", path: "Membranophones/Struck Membranophones/Conga/Conga_HitN_v3_rr1_Sum.wav" },
  { group: 'Percussion', name: "Conga, Quinto", file: "perc/conga-quinto.flac", path: "Membranophones/Struck Membranophones/Conga/Quinto_HitN_v2_rr1_Sum.wav" },
  { group: 'Percussion', name: "Conga, Tumba", file: "perc/conga-tumba.flac", path: "Membranophones/Struck Membranophones/Conga/Tumba_HitN_v4_rr1_Sum.wav" },
  { group: 'Percussion', name: "Bongo, High", file: "perc/bongo-high.flac", path: "Membranophones/Struck Membranophones/Bongos/BongoH_Hit1_v1_rr1_Mid.wav" },
  { group: 'Percussion', name: "Bongo, Low", file: "perc/bongo-low.flac", path: "Membranophones/Struck Membranophones/Bongos/BongoL_Hit1_v1_rr1_Mid.wav" },
  { group: 'Percussion', name: "Darbuka", file: "perc/darbuka.flac", path: "Membranophones/Struck Membranophones/Darbuka/Darbuka_1_hit_vl1_rr1.wav" },
  { group: 'Percussion', name: "Frame Drum", file: "perc/frame-drum.flac", path: "Membranophones/Struck Membranophones/Frame Drum/HDrumL_Hit_v3_rr2_Sum.wav" },
  { group: 'Percussion', name: "Cajon", file: "perc/cajon.flac", path: "Idiophones/Struck Idiophones/Cajon/Cajon_hit1_f_rr1.wav" },
  { group: 'Percussion', name: "Tambourine Hit", file: "perc/tambourine-hit.flac", path: "Idiophones/Struck Idiophones/Tambourine 1/Tamb1_Hit_v2_rr1_Mid.wav" },
  { group: 'Percussion', name: "Tambourine Roll", file: "perc/tambourine-roll.flac", path: "Idiophones/Struck Idiophones/Tambourine 1/Tamb1_Roll_v2_rr1_Mid.wav" },
  { group: 'Percussion', name: "Shaker, Small", file: "perc/shaker-small.flac", path: "Idiophones/Struck Idiophones/Shaker, Small/Mid_ShakerDouble_Down_rr1.wav" },
  { group: 'Percussion', name: "Shaker, Large", file: "perc/shaker-large.flac", path: "Idiophones/Struck Idiophones/Shaker, Large/LShaker_Shake1D_rr2_Mid.wav" },
  { group: 'Percussion', name: "Cowbell", file: "perc/cowbell.flac", path: "Idiophones/Struck Idiophones/Cowbells/Cowbell1_Normal_v3_rr1_Mid.wav" },
  { group: 'Percussion', name: "Claves", file: "perc/claves.flac", path: "Idiophones/Struck Idiophones/Claves/Claves1_Hit_v1_rr1_Mid.wav" },
  { group: 'Percussion', name: "Woodblock", file: "perc/woodblock.flac", path: "Idiophones/Struck Idiophones/Woodblock/wood_click_f_rr2.wav" },
  { group: 'Percussion', name: "Triangle", file: "perc/triangle.flac", path: "Idiophones/Struck Idiophones/Triangles/Triangle1_Hit_v1_rr1_Mid.wav" },
  { group: 'Percussion', name: "Cabasa", file: "perc/cabasa.flac", path: "Idiophones/Struck Idiophones/Cabasa/Cabasa1_Hit_rr1_Mid.wav" },
  { group: 'Percussion', name: "Guiro", file: "perc/guiro.flac", path: "Idiophones/Struck Idiophones/Guiro/Guiro_Med_rr1_Mid.wav" },
  { group: 'Percussion', name: "Agogo, High", file: "perc/agogo-high.flac", path: "Idiophones/Struck Idiophones/Agogo Bells/Agogo_High_v1_rr1_Mid.wav" },
  { group: 'Percussion', name: "Agogo, Low", file: "perc/agogo-low.flac", path: "Idiophones/Struck Idiophones/Agogo Bells/Agogo_Low_v1_rr1_Mid.wav" },
  { group: 'Percussion', name: "Sleigh Bells", file: "perc/sleigh-bells.flac", path: "Idiophones/Struck Idiophones/Sleigh Bells/Sleighbells_Hit_rr1_Mid.wav" },
  { group: 'Percussion', name: "Vibraslap", file: "perc/vibraslap.flac", path: "Idiophones/Struck Idiophones/Vibraslap/Legacy/vibraslap_rr1.wav" },
  { group: 'Percussion', name: "Hand Clap", file: "perc/hand-clap.flac", path: "Idiophones/Struck Idiophones/Claps/Clap_rr1.wav" },
  { group: 'Percussion', name: "Wind Chimes", file: "perc/wind-chimes.flac", path: "Idiophones/Struck Idiophones/Mark Trees/Legacy/windchimes_asc1.wav" },
  { group: 'Percussion', name: "Finger Cymbals", file: "perc/finger-cymbals.flac", path: "Idiophones/Struck Idiophones/Finger Cymbals/Fing_Cymb.wav" },
  { group: 'Percussion', name: "Log Drum", file: "perc/log-drum.flac", path: "Idiophones/Struck Idiophones/Slit Drum/LogDrumHi_MedM_v2_rr1_Sum.wav" },
];

const NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];

// A CC0 instrument's samples: the upstream note name and the file it's saved as (e.g. "Cs4").
export function cc0Samples(dir) {
  const { notes, shift = 0 } = CC0_INSTRUMENTS[dir];
  return notes.split(' ').map(upstream => {
    const [, letter, octave] = upstream.match(/^([A-G]#?)(-?\d)$/);
    return { upstream, name: NAMES[NAMES.indexOf(letter.replace('#', 's'))] + (Number(octave) + shift) };
  });
}
