// knowledge.js — the chat brain's "Wikipedia training", offline.
//
// The owner asked: "AI chat ke liye properly trained nahi hai — use train
// karne ke liye Wikipedia use karo". Three layers deliver that:
//
//   1. BUILTIN_KNOWLEDGE (this file) — a curated, Wikipedia-derived fact bank
//      (stable GK: India, world, science, tech, history, sports, space), with
//      Hinglish + English answers, so chat is factually strong out of the box
//      and answers instantly with zero AI and zero network.
//   2. Learned Wikipedia entries (store.data.wikiKnowledge) — anything the
//      agent has fetched from Wikipedia at runtime (/wiki, auto-grounding,
//      `npm run train:wiki`) is remembered and matched before the network.
//   3. Live Wikipedia (src/wiki.js) — current facts fetched on demand and
//      injected into the AI prompt as verified context.
//
// Facts are stable, evergreen ones (speed of light, capitals, history). For
// current people/numbers the live Wikipedia layer is the source of truth.

import { matchScorePrepared } from './neural/index.js';
import { preparePairSide } from './neural/text.js';

// Shared-token sanity check must count CONTENT words only — "kya"/"hai" style
// stopwords made "bhai kya haal hai" match "pravakash sanshleshan kya hai".
const MATCH_STOP = new Set([
  'kya', 'hai', 'hain', 'ho', 'hoon', 'ke', 'ki', 'ka', 'me', 'mein', 'ko', 'se', 'pe', 'par',
  'the', 'is', 'of', 'a', 'an', 'to', 'in', 'and', 'or', 'what', 'who', 'how', 'when', 'where',
  'batao', 'bata', 'kaisa', 'kaisi', 'kaise', 'ye', 'yeh', 'wo', 'wahi', 'liye', 'wala',
  'bhai', 'yaar', 'bro', 'please', 'plz', 'tell', 'about', 'explain', 'did', 'does', 'do',
]);

const normalize = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/\bu\b/g, 'you')
  .replace(/\bur\b/g, 'your')
  .replace(/\br\b/g, 'are')
  .replace(/\bthx\b/g, 'thanks')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// ── 1. Curated evergreen fact bank (Wikipedia-derived, CC BY-SA spirit) ─────

const entry = (id, keys, en, hi) => ({ id, keys, en, hi });

export const BUILTIN_KNOWLEDGE = [
  // ── India ──
  entry('india_capital', ['capital of india', 'india capital', 'india ki capital', 'bharat ki rajdhani', 'rajdhani of india', 'india capital city'],
    "India's capital is *New Delhi* — the seat of the central government, inside the National Capital Territory (NCT) of Delhi.",
    "India ki rajdhani *New Delhi* hai — central government yahin hai, ye Delhi NCT ka hissa hai."),
  entry('india_independence', ['independence day of india', 'india independence', 'india ko azadi', 'azadi kab mili', '15 august', 'independence day'],
    'India became independent from British rule on *15 August 1947*. Jawaharlal Nehru became the first Prime Minister.',
    'India ko British rule se *15 August 1947* ko azaadi mili. Jawaharlal Nehru pehle Prime Minister bane.'),
  entry('india_republic', ['republic day of india', 'india republic day', 'gantantra diwas', '26 january'],
    'India became a republic on *26 January 1950*, when the Constitution of India came into force.',
    '*26 January 1950* ko India republic bana — Constitution lagu hua. Ise har saal Gantantra Diwas ke roop me manate hain.'),
  entry('india_constitution', ['constitution of india', 'indian constitution', 'bharat ka samvidhan', 'samvidhan'],
    "The Constitution of India was adopted on 26 November 1949 and came into force on 26 January 1950. Dr. B. R. Ambedkar chaired the drafting committee — it is the world's longest written constitution.",
    'Bharat ka Samvidhan 26 November 1949 ko adopt hua aur 26 January 1950 ko lagu hua. Drafting committee ke chairman *Dr. B. R. Ambedkar* the — ye duniya ka sabse lamba written constitution hai.'),
  entry('india_anthem', ['national anthem of india', 'india national anthem', 'jana gana mana', 'rashtriya gaan'],
    "\"Jana Gana Mana\" is India's national anthem, written by Rabindranath Tagore and first sung in 1911.",
    'India ka rashtriya gaana *Jana Gana Mana* hai — Rabindranath Tagore ne likha, pehli baar 1911 me gaya gaya.'),
  entry('india_national_animal', ['national animal of india', 'india national animal', 'rashtriya pashu'],
    "India's national animal is the *Bengal tiger*.",
    'India ka rashtriya pashu *Bengal tiger* (baagh) hai.'),
  entry('india_national_bird', ['national bird of india', 'india national bird'],
    "India's national bird is the *Indian peacock* (mayur).",
    'India ka rashtriya pakshi *Indian peacock* (mayur) hai.'),
  entry('india_national_flower', ['national flower of india', 'india national flower'],
    "India's national flower is the *lotus* (kamal).",
    'India ka rashtriya pushp *lotus* (kamal) hai.'),
  entry('india_national_fruit', ['national fruit of india', 'india national fruit'],
    "India's national fruit is the *mango*.",
    'India ka rashtriya phal *aam* (mango) hai.'),
  entry('india_national_game', ['national game of india', 'india national game', 'rashtriya khel'],
    'Fun fact: India has *no official national game*. Hockey is often called one, but the government has confirmed there is no officially declared national sport.',
    'Interesting fact: India ka *koi official national game nahi* hai! Hockey ko aksar kaha jata hai, par government ne confirm kiya hai ki officially koi national sport declare nahi hua.'),
  entry('india_states', ['how many states in india', 'india states count', 'india me kitne rajya', 'states and union territories of india'],
    'India has *28 states and 8 union territories* (since the 2019 J&K reorganisation).',
    'India me *28 states aur 8 union territories* hain (2019 ke J&K reorganisation ke baad).'),
  entry('india_population', ['population of india', 'india population', 'india ki abadi'],
    "India is the world's most populous country (since 2023), with roughly 1.45 billion people.",
    'India duniya ka sabse zyada abadi wala desh hai (2023 se) — taqreeban *1.45 billion* log.'),
  entry('india_currency', ['currency of india', 'india currency', 'india ka paisa', 'rupee symbol'],
    "India's currency is the *Indian Rupee* (₹, code INR). The ₹ symbol was designed by D. Udaya Kumar and adopted in 2010.",
    'India ki currency *Indian Rupee* (₹, INR) hai. ₹ symbol D. Udaya Kumar ne design kiya, 2010 me adopt hua.'),
  entry('india_ganga', ['longest river in india', 'ganga river', 'ganges', 'ganga nadi'],
    "The *Ganga* (Ganges), about 2,525 km long from the Gangotri glacier to the Bay of Bengal, is India's longest river.",
    'India ki sabse lambi nadi *Ganga* hai (~2,525 km) — Gangotri glacier se nikal kar Bengal ki khadi me milti hai.'),
  entry('taj_mahal', ['taj mahal', 'taj mahal kisne banaya', 'who built taj mahal'],
    'The *Taj Mahal* (Agra) was built by Mughal emperor *Shah Jahan* in 1632–1653 in memory of Mumtaz Mahal. White marble, UNESCO World Heritage Site.',
    '*Taj Mahal* (Agra) ko Mughal badshah *Shah Jahan* ne 1632–1653 me Mumtaz Mahal ki yaad me banwaya tha. Safed marble, UNESCO World Heritage Site hai.'),
  entry('gandhi', ['mahatma gandhi', 'gandhiji', 'father of the nation india', 'bapu'],
    "*Mahatma Gandhi* (Mohandas Karamchand Gandhi, 1869–1948) is India's Father of the Nation — led the freedom struggle through non-violence (ahimsa) and movements like Quit India and the Salt March.",
    '*Mahatma Gandhi* (1869–1948) ko Bharat ke Rashtrapita ke roop me jaana jata hai — ahimsa aur Quit India, Salt March jaise andolan se azaadi dilayi.'),
  entry('nehru', ['jawaharlal nehru', 'first prime minister of india', 'pehla pradhan mantri', "children's day"],
    "Jawaharlal Nehru was India's first Prime Minister (1947–1964). His birthday, 14 November, is celebrated as Children's Day.",
    '*Jawaharlal Nehru* India ke pehle Prime Minister the (1947–1964). Unka janmdin 14 November *Children\u2019s Day* ke roop me manaya jata hai.'),
  entry('ambedkar', ['b r ambedkar', 'ambedkar', 'father of indian constitution', 'bhimrao ambedkar'],
    'Dr. *B. R. Ambedkar* (1891–1956) chaired the drafting of the Constitution of India and is called its Father. His birth anniversary, 14 April, is a public holiday.',
    'Dr. *B. R. Ambedkar* (1891–1956) ne Constitution drafting committee ki adhyaksha ki aur unhein Samvidhan ke Janak kehte hain. Unka janmdin 14 April ko holiday hota hai.'),
  entry('patel', ['sardar patel', 'iron man of india', 'lauh purush'],
    "Sardar *Vallabhbhai Patel* (1875–1950), the 'Iron Man of India', integrated 565 princely states into the Union. His birthday, 31 October, is National Unity Day; the Statue of Unity (182 m, Gujarat) is his memorial.",
    'Sardar *Vallabhbhai Patel* (1875–1950) — "Iron Man of India" — ne 565 princely states ko Bharat me milaya. 31 October ko National Unity Day manaya jata hai; Gujarat me *Statue of Unity* (182 m) unka smarak hai.'),
  entry('bhagat_singh', ['bhagat singh', 'bhagat singh kaun the'],
    '*Bhagat Singh* (1907–1931) was a revolutionary freedom fighter, hanged by the British at age 23 along with Rajguru and Sukhdev.',
    '*Bhagat Singh* (1907–1931) ek krantikari freedom fighter the — 23 ki umar me British ne Rajguru aur Sukhdev ke saath phaansi di.'),
  entry('ashoka', ['ashoka', 'ashoka the great', 'emperor ashoka', 'samrat ashoka'],
    'Emperor *Ashoka* (Maurya dynasty, ruled c. 268–232 BCE) united most of the Indian subcontinent. After the bloody Kalinga war he embraced Buddhism and non-violence. The Ashoka Chakra on the Indian flag comes from his pillars.',
    'Samrat *Ashoka* (Maurya vansh, ~268–232 BCE) ne poora bharatiya upmahadweep joda. Kalinga yuddh ke baad Buddhism apnaya. Tirange ka Ashoka Chakra unke stambh se aaya hai.'),
  entry('india_isro', ['isro', 'indian space research organisation', 'isro kya hai', 'isro kab bana'],
    "*ISRO* (Indian Space Research Organisation) was founded in 1969, headquartered in Bengaluru. It runs India's space program — Chandrayaan, Mangalyaan, Aditya-L1, Gaganyaan.",
    '*ISRO* (Indian Space Research Organisation) 1969 me bana, HQ Bengaluru me hai. India ka space program yahi chalata hai — Chandrayaan, Mangalyaan, Aditya-L1, Gaganyaan.'),
  entry('chandrayaan_3', ['chandrayaan 3', 'chandrayaan-3', 'chandrayaan', 'moon south pole india'],
    "*Chandrayaan-3* (ISRO, launched July 2023) soft-landed the *Vikram* lander with the *Pragyan* rover near the Moon's south pole on 23 August 2023 — a world first.",
    '*Chandrayaan-3* (ISRO, 2023) ne 23 August 2023 ko Moon ke *south pole* ke paas Vikram lander aur Pragyan rover ko safely utara — duniya me pehli baar.'),
  entry('mangalyaan', ['mangalyaan', 'mars orbiter mission', 'india mars mission'],
    "*Mangalyaan* (Mars Orbiter Mission, 2013–14) made India the first Asian nation to reach Mars orbit — and the first ever to succeed on its maiden attempt, on a famously small budget.",
    '*Mangalyaan* (Mars Orbiter Mission, 2013–14) se India Mars orbit tak pahunchne wala pehla Asian desh bana — aur pehli attempt me hi safal hone wala duniya ka pehla mission, chhote budget ke saath.'),
  entry('aditya_l1', ['aditya l1', 'aditya-l1', 'sun mission india', 'solar mission isro'],
    "*Aditya-L1* (ISRO, launched Sept 2023) is India's first dedicated solar observatory, stationed at the Sun–Earth Lagrange point L1, about 1.5 million km from Earth.",
    '*Aditya-L1* (ISRO, Sept 2023) India ka pehla dedicated solar observatory hai — Sun–Earth L1 point pe tainaat, dharti se ~1.5 million km door.'),
  entry('jallianwala', ['jallianwala bagh', 'jallianwala bagh massacre', 'jallianwala bagh kab hua'],
    'The *Jallianwala Bagh massacre* happened on 13 April 1919 in Amritsar, when British troops fired on an unarmed crowd — a turning point in the freedom struggle.',
    '*Jallianwala Bagh hatyakand* 13 April 1919 ko Amritsar me hua tha — British fauj ne nihath bheed par goli chalayi thi. Ye azaadi sangharsh ka turning point bana.'),
  entry('quit_india', ['quit india movement', 'quit india 1942', 'bharat chhodo andolan'],
    'The *Quit India Movement* was launched by Mahatma Gandhi on 8 August 1942 in Bombay with the slogan "Do or Die".',
    '*Quit India Movement* (Bharat Chhodo Andolan) Mahatma Gandhi ne 8 August 1942 ko Bombay me shuru kiya tha — "Karo ya Maro" ke naare ke saath.'),
  entry('first_war_independence', ['first war of independence', '1857 revolt', 'revolt of 1857', 'sepoy mutiny'],
    "The *Revolt of 1857* (also called the First War of Indian Independence) began with sepoys at Meerut and spread across north India — the British Crown took direct control after it.",
    '*1857 ki Kranti* (First War of Independence) Meerut ke sipahiyon se shuru hui aur uttar Bharat me phaili — iske baad British Crown ka seedha shasan aaya.'),
  entry('british_raj', ['british raj', 'british rule in india', 'angrez kab aaye'],
    'The British Raj — direct British rule over the Indian subcontinent — lasted from *1858 to 1947*.',
    'British Raj — bharatiya upmahadweep par British seedha shasan — *1858 se 1947* tak raha.'),

  // ── World GK ──
  entry('earth_planet', ['which planet do we live on', 'earth planet', 'our planet', 'dharti kaun si grah'],
    'Earth is the *3rd planet from the Sun* and the only known world with life — about 71% of its surface is water, and it is ~4.54 billion years old.',
    'Earth *Suraj se teesra grah* hai aur jeevan wali known duniya — surface ka ~71% paani hai, umar ~4.54 billion saal.'),
  entry('sun_distance', ['distance of sun from earth', 'sun distance', 'suraj kitni door', 'how far is the sun'],
    'The Sun is about *150 million km* from Earth — sunlight takes roughly *8 minutes 20 seconds* to reach us.',
    'Suraj dharti se taqreeban *150 million km* door hai — sunlight ko yahan pahunchne me *8 minute 20 second* lagte hain.'),
  entry('everest', ['mount everest', 'highest mountain in world', 'sabse unchi choti', 'everest height'],
    '*Mount Everest* (8,849 m), on the Nepal–China (Tibet) border in the Himalayas, is the world\u2019s highest peak.',
    '*Mount Everest* (8,849 m) — Himalaya me Nepal–China border par — duniya ki sabse unchi choti hai.'),
  entry('nile', ['longest river in the world', 'nile river', 'sabse lambi nadi'],
    'The *Nile* (~6,650 km) in Africa is the world\u2019s longest river; the Amazon is the largest by water volume.',
    'Duniya ki sabse lambi nadi *Nile* (~6,650 km, Africa) hai; paani ki volume me Amazon sabse badi hai.'),
  entry('pacific', ['largest ocean', 'pacific ocean', 'sabse bada mahasagar'],
    'The *Pacific Ocean* is the largest and deepest ocean on Earth — over one-third of the planet\u2019s surface.',
    '*Pacific Ocean* dharti ka sabse bada aur gehra mahasagar hai — dharti ke surface ka ek-tihai se zyada.'),
  entry('sahara', ['largest desert', 'sahara desert', 'sabse bada registan'],
    'The *Sahara* is the largest hot desert in the world (North Africa); overall the largest desert is Antarctica (a cold desert).',
    'Duniya ka sabse bada garam registan *Sahara* hai (North Africa); kul mila kar sabse bada desert Antarctica hai (thanda desert).'),
  entry('un', ['united nations', 'un kya hai', 'united nations founded'],
    'The *United Nations* was founded on 24 October 1945 (after WWII) to maintain international peace and security. HQ: New York; 193 member states.',
    '*United Nations* 24 October 1945 ko bana (WWII ke baad) — international shanti aur suraksha ke liye. HQ New York; 193 members.'),
  entry('ww2', ['world war 2', 'second world war', 'wwii', 'world war two kab hui'],
    'World War II lasted *1939–1945* — the deadliest conflict in history, ending after atomic bombs on Hiroshima and Nagasaki and the surrender of Germany and Japan.',
    'World War II *1939–1945* me lada gaya — itihaas ka sabse vinashkari yuddh. Hiroshima–Nagasaki par atomic bomb aur Germany–Japan ke aatmasamarpan ke baad khatam hua.'),
  entry('ww1', ['world war 1', 'first world war', 'wwi', 'world war one kab hui'],
    'World War I lasted *1914–1918*, triggered by the assassination of Archduke Franz Ferdinand; trenches and poison gas defined it.',
    'World War I *1914–1918* raha — Archduke Franz Ferdinand ki hatya se shuru hua; trench warfare aur poison gas iski pehchan the.'),

  // ── Science ──
  entry('speed_of_light', ['speed of light', 'light speed', 'prakash ki gati', 'light ki speed'],
    'The speed of light in vacuum is exactly *299,792,458 metres per second* (~300,000 km/s). Nothing with mass can reach it.',
    'Vaccuum me light ki raftaar exactly *299,792,458 metres per second* (~300,000 km/s) hai. Mass wali koi cheez is tak nahi pahunch sakti.'),
  entry('gravity', ['acceleration due to gravity', 'gravity on earth', 'gravitational acceleration', 'g value', 'gravity value'],
    "Earth's gravitational acceleration is about *9.8 m/s²* (g = 9.80665 m/s²). On the Moon it is ~1.62 m/s².",
    'Dharti par gravity ka acceleration taqreeban *9.8 m/s²* hai (9.80665 precise). Moon par ~1.62 m/s².'),
  entry('speed_of_sound', ['speed of sound', 'sound ki speed', 'sound speed in air'],
    'The speed of sound in dry air at 20 °C is about *343 m/s* (~1,235 km/h).',
    '20 °C par khushk hawa me sound ki raftaar taqreeban *343 m/s* (~1,235 km/h) hai.'),
  entry('absolute_zero', ['absolute zero', 'coldest temperature', 'absolute zero value'],
    '*Absolute zero* — the lowest possible temperature — is *−273.15 °C* (0 kelvin).',
    '*Absolute zero* — sabse kam sambhavit temperature — *−273.15 °C* (0 kelvin) hai.'),
  entry('water_formula', ['formula of water', 'water chemical formula', 'h2o'],
    'Water\u2019s chemical formula is *H₂O* — two hydrogen atoms and one oxygen atom.',
    'Paani ka chemical formula *H₂O* hai — do hydrogen atoms aur ek oxygen atom.'),
  entry('photosynthesis', ['photosynthesis', 'photosynthesis kya hai', 'pravakash sanshleshan'],
    'Photosynthesis is how green plants convert sunlight, water and carbon dioxide into glucose and oxygen — the base of almost every food chain. Equation: 6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂.',
    'Photosynthesis wo process hai jisme hari paudhe sunlight, paani aur CO₂ se glucose aur oxygen banate hain — lagbhag har food chain ki neev. Equation: 6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂.'),
  entry('dna', ['what is dna', 'dna full form', 'dna kya hai'],
    'DNA (*deoxyribonucleic acid*) is the molecule that carries genetic instructions — a double-helix structure identified by Watson, Crick and Franklin in 1953.',
    'DNA (*deoxyribonucleic acid*) wo molecule hai jo genetic instructions carry karta hai — 1953 me Watson, Crick aur Franklin ne double-helix structure identify kiya.'),
  entry('human_bones', ['how many bones in human body', 'human bones count', 'sharir me haddiyan'],
    'An adult human body has *206 bones* (babies are born with about 270, which fuse as they grow).',
    'Ek adult human body me *206 bones* hote hain (bachche ~270 ke kareeb paida hote hain jo badhte hue jud jate hain).'),
  entry('newton_laws', ['newton laws of motion', "newton's laws", 'newton ke niyam', 'laws of motion'],
    'Newton\u2019s three laws of motion: (1) inertia — a body stays at rest or in uniform motion unless a force acts; (2) F = ma; (3) every action has an equal and opposite reaction.',
    'Newton ke gati ke teen niyam: (1) *Law of Inertia* — koi vastu apni sthiti/raftaar me bina force ke bani rahe; (2) *F = ma*; (3) har action ka barabar aur vipreet reaction hota hai.'),
  entry('periodic_table', ['periodic table', 'who made periodic table', 'periodic table elements'],
    'The periodic table organises the chemical *elements* (118 confirmed) by atomic number. It was created by *Dmitri Mendeleev* in 1869, who even predicted then-unknown elements.',
    'Periodic table chemical *elements* (118 confirmed) ko atomic number se organize karti hai. Ise *Dmitri Mendeleev* ne 1869 me banayi — unhone tab anjaan elements ka prediction bhi kiya tha.'),
  entry('light_year', ['what is a light year', 'light year', 'light year kya hai'],
    'A *light-year* is the distance light travels in one year — about *9.46 trillion kilometres*. It measures distance, not time.',
    '*Light-year* wo doori hai jo light ek saal me tay karti hai — taqreeban *9.46 trillion km*. Ye doori ka measure hai, samay ka nahi.'),
  entry('big_bang', ['big bang', 'big bang theory', 'universe age', 'universe kaise bana'],
    'The *Big Bang* — the origin of the universe — happened about *13.8 billion years ago*. The observable universe is still expanding.',
    '*Big Bang* — brahmand ka aarambh — taqreeban *13.8 billion saal* pehle hua. Observable universe abhi bhi expand ho raha hai.'),
  entry('black_hole', ['black hole', 'black hole kya hai'],
    'A *black hole* is a region of space where gravity is so strong that not even light can escape. The first image of one (M87*) was captured in 2019.',
    '*Black hole* space ka wo hissa hai jahan gravity itni strong hai ki light bhi bahar nahi aa sakti. Iska pehla photo (M87*) 2019 me liya gaya.'),
  entry('blood_groups', ['blood groups', 'blood group types', 'abo blood group', 'kitne blood group'],
    'The main human blood groups are *A, B, AB and O*, each Rh-positive or negative. O-negative is the universal donor; AB-positive the universal recipient.',
    'Mukhya human blood groups *A, B, AB aur O* hain (har ek Rh+ ya Rh−). O-negative universal donor hai; AB-positive universal recipient.'),
  entry('ph_scale', ['ph scale', 'ph value', 'ph kya hai'],
    'The *pH scale* (0–14) measures acidity: below 7 is acidic, 7 is neutral, above 7 is basic. Lemon juice ≈ 2, water = 7, soap ≈ 9–10.',
    '*pH scale* (0–14) acidity naapti hai: 7 se kam acidic, 7 neutral, 7 se zyada basic. Nimbu ≈ 2, paani = 7, sabun ≈ 9–10.'),

  // ── Maths ──
  entry('pi', ['value of pi', 'pi value', 'pi constant', 'what is pi'],
    '*π (pi)* ≈ *3.14159265* — the ratio of a circle\u2019s circumference to its diameter.',
    '*π (pi)* ≈ *3.14159265* — kisi circle ka circumference aur diameter ka ratio.'),
  entry('euler_e', ['value of e', 'euler number', "euler's number"],
    '*e (Euler\u2019s number)* ≈ *2.71828* — the base of natural logarithms, fundamental in growth/compound-interest maths.',
    '*e (Euler number)* ≈ *2.71828* — natural logarithm ki base, growth/compound-interest maths me moolbhut.'),
  entry('pythagoras', ['pythagoras theorem', 'pythagorean theorem', 'pythagoras ka sutra'],
    'The Pythagorean theorem: in a right-angled triangle, *a² + b² = c²* (c is the hypotenuse).',
    'Pythagoras ka pramey: samkon tribhuj me *a² + b² = c²* (c karn/hypotenuse hai).'),
  entry('prime_numbers', ['prime number', 'prime numbers kya hote', 'what is a prime number'],
    'A *prime number* is a whole number greater than 1 with exactly two factors: 1 and itself — e.g. 2, 3, 5, 7, 11. (2 is the only even prime.)',
    '*Prime number* wo whole number hai jo 1 se bada ho aur jiske sirf do factors hon: 1 aur wo khud — jaise 2, 3, 5, 7, 11. (2 akeli even prime hai.)'),

  // ── Tech ──
  entry('www', ['who invented world wide web', 'world wide web', 'www invented', 'internet kisne banaya', 'web kisne banaya'],
    'The *World Wide Web* was invented by *Tim Berners-Lee* at CERN in 1989–1991 (the first website went live in 1991). The underlying internet grew from ARPANET (1969).',
    '*World Wide Web* ko *Tim Berners-Lee* ne CERN me 1989–1991 me banaya (pehli website 1991 me live hui). Internet ki neev ARPANET (1969) se bani.'),
  entry('python_lang', ['who made python', 'python language', 'python kisne banai', 'python inventor'],
    'The *Python* programming language was created by *Guido van Rossum* and released in 1991. Named after Monty Python, not the snake!',
    '*Python* programming language *Guido van Rossum* ne banayi, 1991 me release hui. Naam Monty Python se pada — saanp se nahi!'),
  entry('js_lang', ['who made javascript', 'javascript language', 'javascript kisne banai', 'js inventor'],
    '*JavaScript* was created by *Brendan Eich* at Netscape in 1995 (in about 10 days) — the language of the web browser.',
    '*JavaScript* ko *Brendan Eich* ne 1995 me Netscape me banaya (taqreeban 10 din me) — web browser ki zubaan.'),
  entry('linux', ['who made linux', 'linux kisne banaya', 'linux torvalds', 'linux os'],
    '*Linux* — the open-source kernel used by most servers and Android — was started by *Linus Torvalds* in 1991 while a student in Finland.',
    '*Linux* — open-source kernel jo zyadatar servers aur Android use karte hain — *Linus Torvalds* ne 1991 me Finland me student rahate hue shuru kiya.'),
  entry('ai_basics', ['what is artificial intelligence', 'artificial intelligence kya hai', 'ai kya hai', 'what is ai'],
    '*Artificial Intelligence (AI)* is software that performs tasks needing human-like intelligence — learning, reasoning, language, vision. The term was coined at the 1956 Dartmouth workshop; the *Turing Test* (1950) is its classic benchmark.',
    '*Artificial Intelligence (AI)* wo software hai jo human-jaisi soch wale kaam karta hai — seekhna, reasoning, language, vision. Ye term 1956 ke Dartmouth workshop me aayi; *Turing Test* (1950) iska classic benchmark hai.'),
  entry('chatgpt', ['what is chatgpt', 'chatgpt kya hai', 'chatgpt launched', 'openai chatgpt'],
    '*ChatGPT* (OpenAI) — a conversational AI chatbot — was launched on *30 November 2022* and reached 100 million users within two months.',
    '*ChatGPT* (OpenAI) — ek conversational AI chatbot — *30 November 2022* ko launch hua aur do mahine me 100 million users tak pahunch gaya.'),
  entry('bitcoin', ['what is bitcoin', 'bitcoin kya hai', 'satoshi nakamoto', 'blockchain kya hai'],
    '*Bitcoin* is the first cryptocurrency, created in 2009 by the pseudonymous *Satoshi Nakamoto* on a *blockchain* — a public, tamper-proof digital ledger.',
    '*Bitcoin* pehli cryptocurrency hai, 2009 me *Satoshi Nakamoto* (pseudonym) ne *blockchain* par banayi — ek public, ched-chad-proof digital ledger.'),
  entry('html', ['what is html', 'html full form', 'html kya hai'],
    '*HTML* (HyperText Markup Language) is the standard markup language for creating web pages — the skeleton of every website.',
    '*HTML* (HyperText Markup Language) web pages banane ki standard markup language hai — har website ka skeleton.'),
  entry('cpu', ['what is cpu', 'cpu full form', 'cpu kya hai'],
    '*CPU* (Central Processing Unit) is the brain of a computer — it executes instructions and performs calculations.',
    '*CPU* (Central Processing Unit) computer ka dimag hai — ye instructions execute karta hai aur calculations karta hai.'),

  // ── History ──
  entry('french_revolution', ['french revolution', 'french revolution kab hui'],
    'The *French Revolution* began in *1789* with the storming of the Bastille — it ended absolute monarchy in France and spread the ideas of liberty, equality and fraternity.',
    '*French Revolution* *1789* me shuru hui (Bastille ke dhwans ke saath) — France me absolute monarchy khatam ki aur liberty, equality, fraternity ke vichar phailaye.'),
  entry('industrial_revolution', ['industrial revolution', 'industrial revolution kab hui'],
    'The *Industrial Revolution* began in Britain in the late 1700s — steam power, factories and railways transformed the world.',
    '*Industrial Revolution* late 1700s me Britain se shuru hua — steam power, factories aur railways ne duniya badal di.'),
  entry('roman_empire', ['roman empire', 'roman empire fall', 'fall of rome'],
    'The *Roman Empire* (27 BCE – 476 CE in the West) shaped Western law, language and architecture. The Western empire fell in *476 CE*.',
    '*Roman Empire* (27 BCE – 476 CE, West me) ne Western law, bhasha aur vastukala ko shape diya. Western empire *476 CE* me gira.'),
  entry('pyramids', ['pyramids of giza', 'pyramids', 'egypt pyramids'],
    'The *Pyramids of Giza* (Egypt) were built around *2560 BCE* as royal tombs — the Great Pyramid is the oldest of the Seven Wonders of the Ancient World.',
    '*Pyramids of Giza* (Egypt) ~*2560 BCE* me rajya samadhi ke roop me bani — Great Pyramid Ancient World ke Saat Ajoobon me sabse purana hai.'),

  // ── Sports ──
  entry('cricket_india', ['india cricket world cup', 'who won cricket world cup 2011', 'who won cricket world cup 1983', 'cricket world cup india'],
    'India has won the Cricket (ODI) World Cup *twice* — 1983 (Kapil Dev\u2019s team) and 2011 (MS Dhoni\u2019s team, on home soil). India also won the T20 World Cup in 2007 and 2024.',
    'India ne Cricket (ODI) World Cup *do baar* jeeta hai — 1983 (Kapil Dev ki team) aur 2011 (MS Dhoni ki team, home ground pe). T20 World Cup 2007 aur 2024 me bhi jeeta.'),
  entry('sachin', ['sachin tendulkar', 'sachin', 'god of cricket', 'sachin centuries'],
    '*Sachin Tendulkar* (born 1973) — the "God of Cricket" — scored 100 international centuries and 34,357 international runs across 24 years.',
    '*Sachin Tendulkar* (janmdin 1973) — "God of Cricket" — ne 24 saal me *100 international centuries* aur 34,357 international runs banaye.'),
  entry('dhoni', ['ms dhoni', 'dhoni', 'captain cool', 'dhoni world cup six'],
    '*MS Dhoni* (b. 1981) — "Captain Cool" — is the only captain to win all three major ICC white-ball trophies (2007 T20 WC, 2011 ODI WC, 2013 Champions Trophy). His 2011 final six is iconic.',
    '*MS Dhoni* (janmdin 1981) — "Captain Cool" — teeno bade ICC white-ball trophies jeetne wale akela captain hain (2007 T20 WC, 2011 ODI WC, 2013 Champions Trophy). 2011 final ka six iconic hai.'),
  entry('olympics', ['olympics', 'first olympic games', 'modern olympics', 'olympics kab shuru hue'],
    'The first *modern Olympic Games* were held in *Athens, 1896* — inspired by the ancient Greek games at Olympia. They are held every 4 years (summer and winter).',
    'Pehli *modern Olympic Games* *Athens, 1896* me hui — purane Greek khelon (Olympia) se prerna. Ye har 4 saal me hoti hain (summer aur winter).'),
  entry('fifa', ['fifa world cup', 'who won most fifa world cups', 'football world cup', 'sabse zyada fifa'],
    '*Brazil* has won the FIFA Football World Cup a record *5 times* (1958, 1962, 1970, 1994, 2002). The first World Cup was held in Uruguay in 1930.',
    '*Brazil* ne FIFA Football World Cup record *5 baar* jeeta hai (1958, 1962, 1970, 1994, 2002). Pehla World Cup 1930 me Uruguay me hua tha.'),
  entry('neeraj', ['neeraj chopra', 'neeraj chopra gold', 'javelin india'],
    '*Neeraj Chopra* won India\u2019s first Olympic athletics gold in javelin at *Tokyo 2020* (held 2021), and silver at Paris 2024.',
    '*Neeraj Chopra* ne javelin me India ka pehla Olympic athletics gold *Tokyo 2020* (2021 me hua) me jeeta, aur Paris 2024 me silver.'),
  entry('bindra', ['abhinav bindra', 'first individual olympic gold india', 'india pehla gold'],
    '*Abhinav Bindra* won India\u2019s first individual Olympic gold in 10m air rifle shooting at the *2008 Beijing Olympics*.',
    '*Abhinav Bindra* ne *2008 Beijing Olympics* me 10m air rifle shooting me India ka pehla individual Olympic gold jeeta.'),

  // ── Life & misc ──
  entry('boiling_freezing', ['boiling point of water', 'freezing point of water', 'paani kab ubalta hai'],
    'Water boils at *100 °C* and freezes at *0 °C* at standard atmospheric pressure.',
    'Standard atmospheric pressure par paani *100 °C* par ubalta hai aur *0 °C* par jamta hai.'),
  entry('vitamin_c', ['vitamin c', 'vitamin c foods', 'scurvy', 'vitamin c kya hai'],
    '*Vitamin C* (ascorbic acid) boosts immunity and prevents scurvy — rich sources: amla, oranges, lemons, guava, capsicum.',
    '*Vitamin C* (ascorbic acid) immunity badhata hai aur scurvy se bachata hai — ache sources: amla, santra, nimbu, amrud, shimla mirch.'),
];

// ── 2. Capital-city mini-bank (generated — compact + complete) ──────────────

const CAPITALS = {
  'afghanistan': 'Kabul', 'australia': 'Canberra', 'austria': 'Vienna', 'bangladesh': 'Dhaka',
  'brazil': 'Brasilia', 'canada': 'Ottawa', 'china': 'Beijing', 'denmark': 'Copenhagen',
  'egypt': 'Cairo', 'finland': 'Helsinki', 'france': 'Paris', 'germany': 'Berlin',
  'greece': 'Athens', 'indonesia': 'Jakarta', 'iran': 'Tehran', 'iraq': 'Baghdad',
  'ireland': 'Dublin', 'italy': 'Rome', 'japan': 'Tokyo', 'kuwait': 'Kuwait City',
  'malaysia': 'Kuala Lumpur', 'mexico': 'Mexico City', 'nepal': 'Kathmandu',
  'netherlands': 'Amsterdam', 'new zealand': 'Wellington', 'north korea': 'Pyongyang',
  'norway': 'Oslo', 'pakistan': 'Islamabad', 'philippines': 'Manila', 'poland': 'Warsaw',
  'portugal': 'Lisbon', 'qatar': 'Doha', 'russia': 'Moscow', 'saudi arabia': 'Riyadh',
  'singapore': 'Singapore', 'south africa': 'Pretoria', 'south korea': 'Seoul',
  'spain': 'Madrid', 'sri lanka': 'Sri Jayawardenepura Kotte', 'sweden': 'Stockholm',
  'switzerland': 'Bern', 'thailand': 'Bangkok', 'turkey': 'Ankara', 'ukraine': 'Kyiv',
  'united arab emirates': 'Abu Dhabi', 'uae': 'Abu Dhabi', 'united kingdom': 'London',
  'uk': 'London', 'united states': 'Washington, D.C.', 'usa': 'Washington, D.C.',
  'vietnam': 'Hanoi',
};

for (const [country, capital] of Object.entries(CAPITALS)) {
  BUILTIN_KNOWLEDGE.push(entry(
    `capital_${country.replace(/\s+/g, '_')}`,
    [`capital of ${country}`, `${country} capital`, `${country} ki capital`, `${country} ki rajdhani`, `${country} capital city`],
    `The capital of ${country[0].toUpperCase()}${country.slice(1)} is *${capital}*.`,
    `${country[0].toUpperCase()}${country.slice(1)} ki rajdhani *${capital}* hai.`,
  ));
}

// ── 3. Matching ─────────────────────────────────────────────────────────────

// Key sides (normalized text, token sets, feature vectors) are precomputed ONCE
// per key and reused — the old code rebuilt them for every key on every lookup
// (that was the 22ms bottleneck). Query side is prepared once per call.
const KEY_CACHE = new Map();
function keySide(key) {
  if (!KEY_CACHE.has(key)) KEY_CACHE.set(key, preparePairSide(normalize(key)));
  return KEY_CACHE.get(key);
}

// Per-item key data (normalized key, content tokens) computed ONCE at module
// load. The old code rebuilt Sets per key per lookup — the real bottleneck.
const ITEM_KEYS = new Map();
function itemKeys(item) {
  if (!ITEM_KEYS.has(item)) {
    ITEM_KEYS.set(item, item.keys.map((key) => {
      const k = normalize(key);
      return {
        k,
        len: k.length,
        words: k.split(' '),
        content: [...preparePairSide(k).toks].filter((w) => !MATCH_STOP.has(w)),
        side: keySide(k),
      };
    }).filter((d) => d.k));
  }
  return ITEM_KEYS.get(item);
}

function scoreEntry(qSide, normQuery, queryWords, queryContent, item) {
  let best = 0;
  for (const { k, len, words, content, side } of itemKeys(item)) {
    let lexical = 0;
    if (normQuery.includes(k)) lexical = len;
    else if (k.includes(normQuery) && normQuery.length >= 5) lexical = normQuery.length;
    else {
      // token overlap fallback ("batao india ki capital kya hai" — key "india ki capital")
      if (words.length >= 2 && words.every((w) => queryWords.has(w))) lexical = len - 1;
    }
    if (lexical > best) best = lexical;
    // Strong lexical hit already — skip the net entirely.
    if (best >= 8 && lexical >= 8) continue;
    // MatchNet semantic score — paraphrase-proof ("bharat ki rajdhani" →
    // "capital of india"). Guards stop OOD false positives: cheap shared
    // content-word prefilter FIRST (the net only runs when plausible), then
    // the high score bar.
    try {
      let shared = false;
      for (let i = 0; i < content.length; i++) {
        if (queryContent.has(content[i])) { shared = true; break; }
      }
      if (!shared) continue;
      const sem = matchScorePrepared(qSide, side);
      if (sem >= 0.9 && sem * 14 > best) best = sem * 14;
    } catch { /* neural brain unavailable — lexical scores still work */ }
  }
  return best;
}

/**
 * Look up the built-in knowledge bank. Returns { id, lang, reply, entry } or
 * null. Replies are WhatsApp-ready and language-matched (Hinglish/English).
 */
import { FastCache } from './fastcache.js';
const LOOKUP_CACHE = new FastCache({ max: 800, ttlMs: 15 * 60_000 });

export function lookupKnowledge(rawText, store = null) {
  const s = String(rawText ?? '').trim();
  if (!s || s.length > 220) return null;
  const normQuery = normalize(s.replace(/^(?:please|plz|bhai|bro|yaar|hey|hi|hello|suno|arre|arey|batao|bata|tell me|what is|who is|kya hai|kaun hai|kab hua|kahan hai)\s+/i, '').replace(/[?!.]+$/, ''));
  if (normQuery.length < 3) return null;
  // ⚡ 3.7.0 result cache — repeated questions answer in ~µs (LRU + TTL)
  const langHint = /[\u0900-\u097F]/.test(s) ? 'd'
    : /\b(kya|kaun|kab|kahan|kaise|hai|ki|ke|me|mein|batao|bata|kisne|hota|hoti)\b/.test(s.toLowerCase()) ? 'h' : 'e';
  const cacheKey = `${normQuery}|${langHint}`;
  const cachedHit = LOOKUP_CACHE.get(cacheKey);
  if (cachedHit !== undefined) return cachedHit;

  const qSide = preparePairSide(normQuery);
  const queryWords = new Set(normQuery.split(' '));
  const queryContent = new Set([...qSide.toks].filter((w) => !MATCH_STOP.has(w)));
  let bestItem = null;
  let bestScore = 0;
  for (const item of BUILTIN_KNOWLEDGE) {
    const sc = scoreEntry(qSide, normQuery, queryWords, queryContent, item);
    if (sc > bestScore) {
      bestScore = sc;
      bestItem = item;
      if (bestScore >= 25) break; // decisive long-key hit — stop scanning
    }
  }
  if (!bestItem || bestScore < 4) { LOOKUP_CACHE.set(cacheKey, null); return null; }

  // Language selection mirrors bilingual.js: prefer Devanagari→hindi_deva, else hinglish/english heuristic.
  let lang = 'english';
  if (/[\u0900-\u097F]/.test(s)) lang = 'hindi_deva';
  else {
    const low = s.toLowerCase();
    if (/\b(kya|kaun|kab|kahan|kaise|hai|ki|ke|me|mein|batao|bata|kisne|hota|hoti|kaa|kya)\b/.test(low)) lang = 'hinglish';
    else if (store?.data?.preferredLanguageMode === 'hinglish') lang = 'hinglish';
  }
  const reply = lang === 'english' ? bestItem.en : bestItem.hi;
  const out = { id: bestItem.id, lang, reply, entry: bestItem };
  LOOKUP_CACHE.set(cacheKey, out);
  return out;
}

/** Prompt block telling the model to treat this fact as verified ground truth. */
export function formatKnowledgeContext(hit) {
  if (!hit?.entry) return '';
  return [
    '[CURATED KNOWLEDGE — WIKIPEDIA-DERIVED GROUND TRUTH (use these exact facts; do not contradict them)]:',
    `• EN: ${hit.entry.en}`,
    `• HI: ${hit.entry.hi}`,
  ].join('\n');
}

// ── 4. Learned Wikipedia entries (the "training store") ─────────────────────

const LEARNED_CAP = 250;

/**
 * Save a fetched Wikipedia summary into the store so future chats answer
 * instantly (and offline) from it — this is the "training" the owner asked for.
 */
export function ingestWikiEntry(store, { query, title, extract, url } = {}) {
  if (!store?.data || !title || !extract) return null;
  const list = Array.isArray(store.data.wikiKnowledge) ? store.data.wikiKnowledge : [];
  const norm = normalize(query || title);
  const existing = list.findIndex((e) => normalize(e.query) === norm || normalize(e.title) === normalize(title));
  const record = {
    query: String(query || title).slice(0, 160),
    title: String(title).slice(0, 160),
    extract: String(extract).slice(0, 1500),
    url: url || '',
    ts: Date.now(),
  };
  if (existing >= 0) list[existing] = record;
  else list.push(record);
  while (list.length > LEARNED_CAP) list.shift();
  store.data.wikiKnowledge = list;
  store.save?.();
  return record;
}

/** Match previously learned Wikipedia entries (instant, offline). */
export function lookupLearnedKnowledge(rawText, store = null) {
  const list = store?.data?.wikiKnowledge;
  if (!Array.isArray(list) || !list.length) return null;
  const normQuery = normalize(rawText);
  if (normQuery.length < 3) return null;
  let best = null;
  let bestScore = 0;
  for (const rec of list) {
    for (const cand of [rec.title, rec.query]) {
      const c = normalize(cand);
      if (!c) continue;
      let sc = 0;
      if (normQuery.includes(c)) sc = c.length;
      else if (c.includes(normQuery) && normQuery.length >= 5) sc = normQuery.length;
      if (sc > bestScore) {
        bestScore = sc;
        best = rec;
      }
    }
  }
  return bestScore >= 4 ? best : null;
}

export function learnedKnowledgeCount(store) {
  return Array.isArray(store?.data?.wikiKnowledge) ? store.data.wikiKnowledge.length : 0;
}
