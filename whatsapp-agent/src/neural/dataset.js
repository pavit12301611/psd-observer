import { V2_EXAMPLES } from './examples-v2.js';

// dataset.js — the labeled training corpus for the neural brain.
//
// Two datasets, both hand-labeled and Hinglish+English+text-speak rich:
//   INTENT_EXAMPLES — message → intent class (12 classes) for the IntentNet
//   MATCH_PARAPHRASES — query → equivalent phrasings (for MatchNet positives;
//     negatives are generated as hard mismatches at train time)
//
// Runtime learning appends to data/neural-examples.json — retrain with
// `npm run train:neural` to fold real conversations into the weights.

export const INTENT_LABELS = [
  'greeting',        // hellos, check-ins
  'gratitude',       // thanks, praise, goodbyes
  'factual',         // what/who/when/where facts
  'comparison',      // X vs Y
  'howto',           // how do I do X (steps, guidance)
  'code',            // programming tasks
  'explain',         // deep understanding, why/how it works
  'emotional',       // feelings, mood, support
  'creative',        // poems, stories, names, captions
  'math',            // calculation, equations
  'personal',        // memory, preferences, reminders about the owner
  'misc_chat',       // chit-chat, opinions, jokes
];

const e = (t, label) => ({ t, label });

export const INTENT_EXAMPLES = [
  ...V2_EXAMPLES,
  // ── greeting ──
  e('hi', 'greeting'), e('hello bhai', 'greeting'), e('hey there', 'greeting'),
  e('kya haal hai', 'greeting'), e('kaise ho', 'greeting'), e('good morning', 'greeting'),
  e('good night bhai', 'greeting'), e('yo', 'greeting'), e('hii', 'greeting'),
  e('namaste ji', 'greeting'), e('sab theek?', 'greeting'), e('aur batao kya chal raha hai', 'greeting'),
  e('hello how are you doing', 'greeting'), e('hey psd', 'greeting'), e('sup', 'greeting'),
  e('good evening', 'greeting'), e('radhe radhe', 'greeting'), e('hola', 'greeting'),

  // ── gratitude ──
  e('thanks', 'gratitude'), e('thank you so much', 'gratitude'), e('shukriya bhai', 'gratitude'),
  e('dhanyavaad', 'gratitude'), e('bahut badhiya kaam kiya', 'gratitude'), e('great job', 'gratitude'),
  e('perfect thanks', 'gratitude'), e('ok bye', 'gratitude'), e('good night and sweet dreams', 'gratitude'),
  e('chal thanks milte hain', 'gratitude'), e('you are amazing', 'gratitude'), e('thanks yaar', 'gratitude'),
  e('tysm', 'gratitude'), e('see you later', 'gratitude'), e('bohot shukriya', 'gratitude'),

  // ── factual ──
  e('what is the capital of india', 'factual'), e('india ki capital kya hai', 'factual'),
  e('who invented the telephone', 'factual'), e('telephone kisne banaya', 'factual'),
  e('when did india get independence', 'factual'), e('speed of light kitni hai', 'factual'),
  e('who is the father of the nation', 'factual'), e('taj mahal kisne banaya', 'factual'),
  e('what is the tallest mountain', 'factual'), e('population of india kitni hai', 'factual'),
  e('who wrote the national anthem', 'factual'), e('water ka formula kya hai', 'factual'),
  e('where is the taj mahal', 'factual'), e('python kisne banayi', 'factual'),
  e('what is photosynthesis', 'factual'), e('how many states in india', 'factual'),
  e('moon kitni door hai', 'factual'), e('who was ashoka', 'factual'),
  e('bitcoin kisne banaya', 'factual'), e('earth ka size kitna hai', 'factual'),
  e('isro kab bana', 'factual'), e('what is the national animal of india', 'factual'),

  // ── comparison ──
  e('tcp vs udp me kya farak hai', 'comparison'), e('difference between ram and rom', 'comparison'),
  e('list vs tuple in python', 'comparison'), e('sql aur nosql me antar batao', 'comparison'),
  e('which is better android or iphone', 'comparison'), e('java vs python kaunsa seekhu', 'comparison'),
  e('compare grpc and rest', 'comparison'), e('difference between ai and ml', 'comparison'),
  e('llm vs traditional chatbot me farak', 'comparison'), e('ev aur petrol car me kya better hai', 'comparison'),
  e('inner join vs left join', 'comparison'), e('which is faster llama or gpt', 'comparison'),
  e('http vs https difference', 'comparison'), e('git vs github me kya antar hai', 'comparison'),
  e('nodejs vs django which is better', 'comparison'), e('savings vs fd kya better hai', 'comparison'),

  // ── howto ──
  e('how to install docker on fedora', 'howto'), e('fedora me docker kaise install karu', 'howto'),
  e('how do i lose weight at home', 'howto'), e('guitar kaise seekhu', 'howto'),
  e('how to make maggi', 'howto'), e('pan card kaise banau', 'howto'),
  e('how to sleep better at night', 'howto'), e('instagram password reset kaise karu', 'howto'),
  e('how to start a youtube channel', 'howto'), e('sim card block kaise karein', 'howto'),
  e('how to prepare for interviews', 'howto'), e('mobile me screenshot kaise lete hain', 'howto'),
  e('how to grow tomatoes', 'howto'), e('online ticket booking kaise karein', 'howto'),
  e('how to learn touch typing', 'howto'), e('passport ke liye apply kaise karein', 'howto'),

  // ── code ──
  e('write a python function to reverse a string', 'code'),
  e('javascript me array sort ka code likho', 'code'),
  e('debug this sql query it is slow', 'code'),
  e('react component banao for login form', 'code'),
  e('write a bash script to backup files', 'code'),
  e('python me file read kaise karu code chahiye', 'code'),
  e('fix this error typeerror cannot read property', 'code'),
  e('code a binary search in c++', 'code'),
  e('write regex to validate email', 'code'),
  e('api call in nodejs example do', 'code'),
  e('sql query likho top 5 customers by revenue', 'code'),
  e('python pandas se csv read karke group by karo', 'code'),
  e('write unit test for this function', 'code'),
  e('dockerfile banao node app ke liye', 'code'),
  e('convert this python code to rust', 'code'),
  e('code to merge two sorted linked lists', 'code'),

  // ── explain ──
  e('explain how neural networks work', 'explain'),
  e('blockchain kaise kaam karta hai detail me batao', 'explain'),
  e('why is the sky blue', 'explain'),
  e('photosynthesis kaise hoti hai samjhao', 'explain'),
  e('how does https work step by step', 'explain'),
  e('explain the theory of relativity simply', 'explain'),
  e('stock market kaise chalta hai samjhao', 'explain'),
  e('why do we dream', 'explain'),
  e('explain recursion with example', 'explain'),
  e('black hole kya hota hai detail me', 'explain'),
  e('how do vaccines work', 'explain'),
  e('gravity kaise kaam karta hai batao', 'explain'),
  e('explain how transformers work in ai', 'explain'),
  e('why does time feel faster when we are busy', 'explain'),
  e('gst kaise calculate hota hai explain karo', 'explain'),

  // ── emotional ──
  e('mood bahut off hai aaj', 'emotional'), e('yaar aaj dil nahi lag raha', 'emotional'),
  e('i am feeling very stressed about exams', 'emotional'),
  e('breakup ho gaya yaar kuch samajh nahi aa raha', 'emotional'),
  e('i feel lonely today', 'emotional'),
  e('kal interview hai bahut dar lag raha hai', 'emotional'),
  e('mujhe neend nahi aa rahi tension ho rahi hai', 'emotional'),
  e('i am not good enough yaar', 'emotional'),
  e('aaj bahut khush hoon bhai', 'emotional'),
  e('job se man bhar gaya hai burnout feel ho raha hai', 'emotional'),
  e('please talk to me i need someone', 'emotional'),
  e('exam me fail ho gaya lag raha hai sab khatam', 'emotional'),

  // ── creative ──
  e('likho ek poem barish pe', 'creative'),
  e('write a short story about a robot', 'creative'),
  e('instagram caption do sunset photo ke liye', 'creative'),
  e('mere startup ke liye naam suggest karo', 'creative'),
  e('birthday wish likho friend ke liye', 'creative'),
  e('write a funny limerick about coding', 'creative'),
  e('shayari likho dosti pe', 'creative'),
  e('youtube video title suggest karo tech channel ke liye', 'creative'),
  e('ek chhota sa motivational quote banao', 'creative'),
  e('rap lyrics likho delhi ke streets pe', 'creative'),
  e('wedding invitation text design karo', 'creative'),
  e('story likho do friends and a time machine', 'creative'),

  // ── math ──
  e('solve 2x + 5 = 15', 'math'), e('x^2 - 5x + 6 = 0 solve karo', 'math'),
  e('15 percent of 240 kitna hota hai', 'math'), e('compound interest nikalo 10000 at 8 percent', 'math'),
  e('45 * 32 + 18 = ?', 'math'), e('integral of 2x dx', 'math'),
  e('gcd of 48 and 180', 'math'), e('5 factorial kitna hota hai', 'math'),
  e('convert 255 to binary', 'math'), e('triangle ka area nikalo base 10 height 6', 'math'),
  e('emi calculate karo 5 lakh loan 9 percent 3 years', 'math'), e('sqrt of 144 plus 15', 'math'),

  // ── personal ──
  e('mera naam pavit hai yaad rakhna', 'personal'),
  e('my favourite colour is blue', 'personal'),
  e('mujhe kal 7 baje meeting ke liye reminder dena', 'personal'),
  e('what do you know about me', 'personal'),
  e('meri yaadadash kaisi hai teri', 'personal'),
  e('i live in dehradun remember that', 'personal'),
  e('mujhe daily morning brief do', 'personal'),
  e('mera birthday 12 march hai note karlo', 'personal'),
  e('who am i', 'personal'),
  e('what is my name', 'personal'),
  e('remember i hate traffic', 'personal'),
  e('meri kya kya training hui hai abhi tak', 'personal'),

  // ── misc_chat ──
  e('batao kuch interesting', 'misc_chat'), e('tell me a joke', 'misc_chat'),
  e('kya tumhe pata hai kya chal raha hai duniya me', 'misc_chat'),
  e('what do you think about ai taking jobs', 'misc_chat'),
  e('chalo thodi baat karte hain', 'misc_chat'),
  e('do you like pizza', 'misc_chat'),
  e('bore ho raha hoon kuch karte hain', 'misc_chat'),
  e('sach bata tu insan hai ya machine', 'misc_chat'),
  e('movie suggest karo', 'misc_chat'),
  e('what is the meaning of life', 'misc_chat'),
  e('yaar tu kitna smart hai', 'misc_chat'),
  e('koi accha gaana sunao', 'misc_chat'),

  // ── extra disambiguation data (targets the hard validation misses) ──
  e('good afternoon', 'greeting'), e('good evening kaise ho', 'greeting'),
  e('subah bakhair', 'greeting'), e('hello sir', 'greeting'), e('hi there how are you', 'greeting'),
  e('hey good morning bhai', 'greeting'), e('good night', 'greeting'), e('gn', 'greeting'),
  e('i am not good enough', 'emotional'), e('not smart enough yaar', 'emotional'),
  e('good for nothing feel hota hai', 'emotional'), e('aaj bahut bura lag raha hai', 'emotional'),
  e('yaar i feel like a failure', 'emotional'), e('khud pe gussa aa raha hai', 'emotional'),
  e('how many states are there in india', 'factual'), e('how much water is on earth', 'factual'),
  e('kitne continent hain duniya me', 'factual'), e('titanic kab doobi thi', 'factual'),
  e('kisne likha vande mataram', 'factual'), e('first president of india kaun the', 'factual'),
  e('when was the internet invented', 'factual'), e('where is mount everest', 'factual'),
  e('compare grpc and rest api', 'comparison'), e('compare python and javascript', 'comparison'),
  e('compare on-premise vs cloud', 'comparison'), e('which one is better ios or android', 'comparison'),
  e('x aur y me se kaunsa better hai', 'comparison'), e('c versus c++ performance', 'comparison'),
  e('write a poem about coding', 'creative'), e('story about a programmer', 'creative'),
  e('caption for my tech photo', 'creative'), e('creative name for tech youtube channel', 'creative'),
  e('write a shayari about programming', 'creative'), e('funny status likho coding life pe', 'creative'),
  e('what is my name', 'personal'), e('who am i to you', 'personal'),
  e('mera naam yaad hai tujhe', 'personal'), e('my favourite food is rajma', 'personal'),
  e('remember my meeting schedule', 'personal'), e('meri profile banao', 'personal'),
  e('what is the meaning of life', 'misc_chat'), e('what do you think about this', 'misc_chat'),
  e('apna opinion batao', 'misc_chat'), e('tell me something fun', 'misc_chat'),
  e('movie suggest karo comedy wali', 'misc_chat'), e('kya tu soch sakta hai', 'misc_chat'),

  // ── lexical-boundary fixes for the remaining hard cases ──
  e('kaise ho aap', 'greeting'), e('kaisi ho', 'greeting'), e('kaisa chal raha hai sab', 'greeting'),
  e('kaise ho yaar', 'greeting'), e('hello kaise hain aap', 'greeting'),
  e('kaam bahut badhiya kiya', 'gratitude'), e('kamaal kar diya', 'gratitude'),
  e('badhiya kaam kiya tune', 'gratitude'), e('bahut accha jawab diya', 'gratitude'),
  e('mobile me screenshot kaise lete hain', 'howto'), e('screenshot kaise lete hain', 'howto'),
  e('ye kaise use karte hain', 'howto'), e('bank me account kaise khulte hain', 'howto'),
  e('debug this code it is not working', 'code'), e('this query is slow optimize karo', 'code'),
  e('error aa raha hai fix karo code me', 'code'), e('code me bug hai dhundh ke fix karo', 'code'),
  e('ek chhota sa motivational quote banao', 'creative'), e('quote banao zindagi pe', 'creative'),
  e('status banao instagram ke liye', 'creative'), e('motivational line likho', 'creative'),
  e('my favourite colour is blue', 'personal'), e('my favourite colour is', 'personal'),
  e('mera favourite food rajma hai', 'personal'), e('my favourite movie is', 'personal'),
  e('batao kuch interesting', 'misc_chat'), e('kuch interesting batao', 'misc_chat'),
  e('apna opinion batao', 'misc_chat'), e('apni rai batao', 'misc_chat'),
  e('teri soch kya hai is baare me', 'misc_chat'), e('bore ho raha hoon kuch batao', 'misc_chat'),

  // ── short-string + banao-boundary hard cases ──
  e('radhe radhe', 'greeting'), e('jai shri krishna', 'greeting'),
  e('ok bye', 'gratitude'), e('chalo bye', 'gratitude'), e('bye bye', 'gratitude'),
  e('tata', 'gratitude'), e('see ya', 'gratitude'), e('chal milte hain', 'gratitude'),
  e('api banao ek simple', 'code'), e('function banao iska', 'code'),
  e('server side code banao', 'code'), e('login form ka code banao', 'code'),
  e('component banao react me', 'code'), e('script banao automation ke liye', 'code'),
  e('poem banao doston pe', 'creative'), e('status banao life pe', 'creative'),
  e('lyrics likho sad song ke liye', 'creative'), e('gaana sunao koi romantic', 'misc_chat'),
  e('koi accha song suggest karo', 'misc_chat'), e('gaana likho mere liye', 'creative'),
  // ── val-boost block: weak classes (greeting/gratitude/howto/explain) + variety ──
  e('namaste ji kaise hain aap', 'greeting'), e('hey there good evening', 'greeting'),
  e('subah bakhair doston', 'greeting'), e('hello ji pranam', 'greeting'),
  e('hi everyone kaise ho sab', 'greeting'), e('yo bro whats up', 'greeting'),
  e('hey good afternoon', 'greeting'), e('salam alaikum bhai', 'greeting'),
  e('radhe radhe ji', 'greeting'), e('jai hind friends', 'greeting'),
  e('good morning team kaise ho', 'greeting'), e('hello hello kya haal hai', 'greeting'),
  e('acha chalta hoon duao me yaad rakhna', 'gratitude'), e('thank you so much yaar', 'gratitude'),
  e('thanks bhai bahut help ki', 'gratitude'), e('dhanyawad aapka', 'gratitude'),
  e('bada shukriya dost', 'gratitude'), e('grateful hoon tumhare liye', 'gratitude'),
  e('thanks yaar time dene ke liye', 'gratitude'), e('bohot bohot shukriya', 'gratitude'),
  e('thank you for everything', 'gratitude'), e('appreciate it yaar thanks', 'gratitude'),
  e('thanks dost kal milte hain', 'gratitude'), e('shukriya bhaijaan', 'gratitude'),
  e('how to make cold coffee at home', 'howto'), e('how do i change my phone wallpaper', 'howto'),
  e('how to lose weight fast at home', 'howto'), e('kaise karein mobile root', 'howto'),
  e('how to take a screenshot on windows', 'howto'), e('how can i improve my english speaking', 'howto'),
  e('how to make maggi without stove', 'howto'), e('how to download youtube videos safely', 'howto'),
  e('how to start a small business in india', 'howto'), e('how do i make paneer at home', 'howto'),
  e('how to prepare for interview in one week', 'howto'), e('how to make website from scratch', 'howto'),
  e('how to tie a tie easily', 'howto'), e('how to fall asleep quickly at night', 'howto'),
  e('explain how a helicopter flies', 'explain'), e('explain why we get fever', 'explain'),
  e('explain how google maps knows traffic', 'explain'), e('why is the sky blue explain simply', 'explain'),
  e('explain the working of a battery', 'explain'), e('explain how fingerprint sensor works', 'explain'),
  e('explain why leaves are green', 'explain'), e('explain how touch screen works', 'explain'),
  e('explain the process of rainfall', 'explain'), e('explain how memory works in brain', 'explain'),
  e('explain what blockchain is in simple words', 'explain'), e('explain how a rocket lands back', 'explain'),
  e('explain why mirrors flip left and right', 'explain'), e('explain how noise cancelling works', 'explain'),
  e('swap two numbers without third variable', 'code'), e('palindrome check program likho', 'code'),
  e('prime numbers print karo code se', 'code'), e('factorial program banao', 'code'),
  e('fibonacci series ka code do', 'code'), e('array sort karne ka code', 'code'),
  e('file read write ka python code', 'code'), e('api call ka example do', 'code'),
  e('25 ka square root kitna hota hai', 'math'), e('45 plus 67 minus 12', 'math'),
  e('72 divide by 8 kitna', 'math'), e('x + 4 = 10 solve karo', 'math'),
  e('20 percent of 150', 'math'), e('area of circle radius 7', 'math'),
  e('simple interest calculate karo 5 percent 2 saal', 'math'), e('average nikalo 45 67 89 ka', 'math'),
  e('mujhe neend nahi aa rahi bahut pareshan hoon', 'emotional'), e('aaj bahut akela mehsoos ho raha hoon', 'emotional'),
  e('exam me fail ho gaya dil toota hai', 'emotional'), e('yaar motivation chahiye please', 'emotional'),
  e('breakup ho gaya bahut dard hai', 'emotional'), e('aaj kuch acha nahi lag raha', 'emotional'),
  e('gaana likho yaaron pe purane dinon ke', 'creative'), e('ek choti si kavita pe ped', 'creative'),
  e('write a funny caption for my gym selfie', 'creative'), e('kahani sunao ek chhoti si', 'creative'),
  e('tagline banao mere chai stall ke liye', 'creative'), e('shayari likho barish pe', 'creative'),
  e('tum kya kar sakte ho batao', 'misc_chat'), e('bore ho raha hoon kuch fun batao', 'misc_chat'),
  e('sach batao tum insaan ho ya robot', 'misc_chat'), e('kya tumhe bhook lagti hai', 'misc_chat'),
  e('mera naam yaad hai tumhe', 'personal'), e('kal mera birthday hai', 'personal'),
  e('meri class 10 me padhta hoon', 'personal'), e('mujhe cricket bahut pasand hai', 'personal'),
  e('mera favourite colour neela hai', 'personal'), e('aaj mera pehla din hai job me', 'personal'),
  e('laptop vs desktop konsa lu', 'comparison'), e('petrol car vs electric car me kya better hai', 'comparison'),
  e('ai vs human intelligence me farak', 'comparison'), e('gmail vs outlook dono me kya difference hai', 'comparison'),
  e('instagram vs snapchat kya difference hai', 'comparison'), e('veg vs non veg protein me kya farak', 'comparison'),
];

// ── Template synthesis: combinatorial training-only data ───────────────────
// Train set = handwritten + these generated variants. Validation stays 100%
// handwritten (held out) — so accuracy numbers measure real generalization.

export const TOPICS = [
  'sun', 'moon', 'india', 'delhi', 'taj mahal', 'cricket', 'football', 'python',
  'javascript', 'linux', 'docker', 'photosynthesis', 'gravity', 'black hole',
  'einstein', 'gandhi', 'ashoka', 'isro', 'nasa', 'bitcoin', 'blockchain', 'ai',
  'machine learning', 'stock market', 'gst', 'wifi', 'bluetooth', 'battery',
  'vaccines', 'dna', 'oxygen', 'everest', 'ganga', 'sahara', 'olympics',
  'world war 2', 'constitution', 'parliament', 'rupay', 'upi', '5g', 'quantum computing',
];

export const SKILLS = [
  'make pasta', 'learn guitar', 'reset a password', 'write a resume', 'grow tomatoes',
  'improve sleep', 'start a podcast', 'edit a video', 'tie a tie', 'meditate',
  'file taxes', 'book a train ticket', 'change a tyre', 'clean a laptop screen',
  'prepare for an interview', 'build a website', 'lose weight', 'save money',
];

const T = (t, label) => ({ t, label });

export function templateExamples(rng = Math.random) {
  const out = [];
  for (const x of TOPICS) {
    out.push(T(`what is ${x}`, 'factual'), T(`${x} kya hai`, 'factual'),
      T(`tell me about ${x}`, 'factual'), T(`${x} ke bare me batao`, 'factual'),
      T(`who invented ${x}`, 'factual'), T(`${x} kisne banaya`, 'factual'),
      T(`where is ${x}`, 'factual'), T(`when was ${x} invented`, 'factual'));
  }
  for (let i = 0; i < TOPICS.length; i += 2) {
    const a = TOPICS[i];
    const b = TOPICS[(i + 1) % TOPICS.length];
    out.push(T(`${a} vs ${b} kya farak hai`, 'comparison'),
      T(`difference between ${a} and ${b}`, 'comparison'),
      T(`compare ${a} and ${b}`, 'comparison'));
  }
  for (const y of SKILLS) {
    out.push(T(`how to ${y}`, 'howto'), T(`${y} kaise karein`, 'howto'),
      T(`${y} ka tarika batao`, 'howto'));
    out.push(T(`write a script to ${y}`, 'code'), T(`${y} ke liye code likho`, 'code'));
    out.push(T(`explain how to ${y} in detail`, 'explain'));
  }
  for (const x of TOPICS.slice(0, 16)) {
    out.push(T(`explain ${x} in detail`, 'explain'), T(`${x} kaise kaam karta hai`, 'explain'),
      T(`why is ${x} important`, 'explain'));
    out.push(T(`solve for x: 2x + 3 = ${x.length + 7}`, 'math'), T(`calculate ${x.length} factorial`, 'math'));
    out.push(T(`write a poem about ${x}`, 'creative'), T(`${x} pe ek kavita likho`, 'creative'),
      T(`caption for a ${x} photo`, 'creative'));
    out.push(T(`yaad rakhna mujhe ${x} pasand hai`, 'personal'), T(`my favourite thing is ${x}`, 'personal'));
    out.push(T(`kya ${x} ke bare me tum kuch bata sakte ho`, 'misc_chat'),
      T(`sochta hai ${x} kaisa hoga`, 'misc_chat'));
    out.push(T(`thanks for the ${x} info`, 'gratitude'), T(`great answer about ${x}`, 'gratitude'));
    out.push(T(`hi there ${x} ke baare me poochhna tha`, 'greeting'));
    out.push(T(`yaar ${x} ke chakkar me mood off hai`, 'emotional'));
  }
  return out;
}


// At train time each group's other entries become hard negatives.

export const MATCH_PARAPHRASES = [
  { target: 'capital of india', queries: ['india ki capital kya hai', 'what is the capital of india', 'bharat ki rajdhani batao', 'india capital city', 'capital city of india'] },
  { target: 'speed of light', queries: ['light ki speed kitni hai', 'what is the speed of light', 'prakash ki gati', 'how fast does light travel'] },
  { target: 'who built taj mahal', queries: ['taj mahal kisne banwaya', 'who built the taj mahal', 'taj mahal ka architect kaun hai', 'taj mahal kisne banaya'] },
  { target: 'photosynthesis', queries: ['photosynthesis kya hai', 'what is photosynthesis', 'paudhe kaise khana banate hain', 'how do plants make food', 'pravakash sanshleshan kya hai'] },
  { target: 'tcp vs udp', queries: ['tcp aur udp me kya farak hai', 'difference between tcp and udp', 'tcp vs udp comparison', 'udp aur tcp me antar'] },
  { target: 'ram vs rom', queries: ['ram aur rom me farak', 'difference between ram and rom', 'ram vs rom kya hai'] },
  { target: 'python list vs tuple', queries: ['list aur tuple me kya antar hai', 'difference between list and tuple in python', 'python list vs tuple'] },
  { target: 'national game of india', queries: ['india ka national game kya hai', 'national game of india', 'india ka rashtriya khel'] },
  { target: 'independence day of india', queries: ['india ko azaadi kab mili', 'when did india get independence', 'independence day of india kab hai', '15 august kyu manate hain'] },
  { target: 'chandrayaan 3', queries: ['chandrayaan 3 kya hai', 'chandrayaan 3 moon landing', 'india moon mission 2023'] },
  { target: 'gravity', queries: ['gravity kya hai', 'gravitational acceleration of earth', 'g ka value kitna hai', 'gravity on earth value'] },
  { target: 'what is dna', queries: ['dna kya hota hai', 'what is dna', 'dna ka full form'] },
  { target: 'who invented world wide web', queries: ['www kisne banaya', 'who invented the web', 'internet kisne invent kiya', 'world wide web inventor'] },
  { target: 'what is chatgpt', queries: ['chatgpt kya hai', 'what is chatgpt', 'openai chatbot kya hai'] },
  { target: 'what is bitcoin', queries: ['bitcoin kya hai', 'what is bitcoin', 'satoshi nakamoto kisne banaya', 'cryptocurrency kya hoti hai'] },
  { target: 'how to install docker', queries: ['docker kaise install karein', 'how to install docker on linux', 'fedora me docker install karna hai'] },
  { target: 'solve quadratic equation', queries: ['x square wala equation solve karo', 'quadratic equation solve', 'solve x^2 + 5x + 6 = 0', 'do ghati wala samaan hal karo'] },
  { target: 'prime number', queries: ['prime number kya hote hain', 'what is a prime number', 'abhajya sankhya kya hai'] },
  { target: 'moon distance', queries: ['moon kitni door hai', 'distance of moon from earth', 'chand dharti se kitna door hai'] },
  { target: 'taj mahal history', queries: ['taj mahal ki history', 'history of taj mahal', 'taj mahal kab bana'] },
  { target: 'how to make maggi', queries: ['maggi kaise banate hain', 'how to cook maggi', 'maggi banane ka tarika'] },
  { target: 'python list reverse', queries: ['list ko reverse kaise karein python me', 'how to reverse a list in python', 'python reverse list'] },
  { target: 'india population', queries: ['india ki abadi kitni hai', 'population of india', 'how many people live in india'] },
  { target: 'newton laws', queries: ['newton ke niyam kya hain', 'newton laws of motion', 'laws of motion explain'] },
  { target: 'binary conversion', queries: ['255 ko binary me convert karo', 'convert 255 to binary', 'decimal to binary 255'] },
  { target: 'isro', queries: ['isro kya hai', 'what is isro', 'indian space research organisation'] },
  { target: 'speed of sound', queries: ['sound ki speed kitni hai', 'what is the speed of sound', 'aawaz ki raftaar'] },
  { target: 'who was gandhi', queries: ['gandhiji kaun the', 'who was mahatma gandhi', 'mahatma gandhi ke baare me batao'] },
  { target: 'file backup script', queries: ['files ka backup script chahiye', 'write a backup script', 'bash backup automation'] },
  { target: 'emotional support', queries: ['mood off hai yaar', 'i am feeling sad', 'tension ho rahi hai bahut', 'dil nahi lag raha'] },
  { target: 'water formula', queries: ['paani ka formula kya hai', 'chemical formula of water', 'h2o kya hota hai'] },
  { target: 'largest ocean', queries: ['duniya ka sabse bada mahasagar', 'which is the largest ocean', 'biggest ocean in the world'] },
  { target: 'python language', queries: ['python kya hai', 'what is python language', 'python programming ke baare me'] },
  { target: 'taj mahal', queries: ['taj mahal kisne banaya', 'who built the taj mahal', 'taj mahal kahan hai'] },
  { target: 'photosynthesis meaning', queries: ['pravakash sanshleshan kya hota hai', 'photosynthesis ka matlab', 'what do you mean by photosynthesis'] },
  { target: 'einstein', queries: ['einstein kaun the', 'who was albert einstein', 'einstein ke baare me batao'] },
  { target: 'indian states', queries: ['bharat me kitne rajya hain', 'how many states in india', 'total states of india'] },
  { target: 'gravity meaning', queries: ['gurutvakarshan kya hai', 'what is gravity', 'gravity ka matlab kya'] },
  { target: 'sql joins', queries: ['sql joins kya hote hain', 'what are sql joins', 'join in sql explain'] },
  { target: 'big bang', queries: ['big bang theory kya hai', 'what is the big bang', 'big bang ke baare me batao'] },
  { target: 'fastest animal', queries: ['duniya ka sabse tez janwar', 'which is the fastest animal', 'fastest land animal kaun sa'] },
];
