// fun.js — 🎉 Timepass mode: GK trivia + riddles (offline bank). `/fun quiz`
// naya sawal, `/fun answer <n>` jawab, `/fun riddle`. Study break ke liye.

export const TRIVIA = [
  { q: 'Duniya ka sabse bada desh kaun sa hai (area me)?', options: ['1. Russia', '2. Canada', '3. China', '4. USA'], answer: 1 },
  { q: 'Insane ka blood group "universal donor" kaun sa hai?', options: ['1. A+', '2. B+', '3. O-', '4. AB+'], answer: 3 },
  { q: 'Python language ka mascot kaun hai?', options: ['1. Parrot', '2. Snake', '3. Lizard', '4. Dinosaur'], answer: 2 },
  { q: '2026 Cricket World Cup kahan hua tha (host)?', options: ['1. India', '2. Australia', '3. England', '4. South Africa'], answer: 2 },
  { q: 'Photosynthesis me plant kaun sa gas leta hai?', options: ['1. Oxygen', '2. Nitrogen', '3. CO2', '4. Hydrogen'], answer: 3 },
  { q: 'Indian Railways ka HQ kahan hai?', options: ['1. Delhi', '2. Mumbai', '3. Kolkata', '4. Chennai'], answer: 2 },
  { q: 'Sun se sabse kareeb planet kaun sa hai?', options: ['1. Venus', '2. Earth', '3. Mercury', '4. Mars'], answer: 3 },
  { q: 'HTML ka full form kya hai?', options: ['1. HyperText Markup Language', '2. HighText Machine Language', '3. Hyperlink Text Language', '4. Home Tool Markup Language'], answer: 1 },
];

export const RIDDLES = [
  { q: 'Aisa kya hai jo paani me daalta hai to mar jaata hai, par paani ke bina zinda nahi rehta?', a: 'Aag 🔥' },
  { q: 'Main bolta hoon par muh nahi hai, bhaagta hoon par pair nahi. Batao kaun?', a: 'Ghadi/Watch ⏰' },
  { q: 'Kitni aisi cheez hai jise aap tod sakte ho bina haath lagaye?', a: 'Vaada (Promise) 🤝' },
  { q: 'Ek kamre me 3 bulb hain, bahar 3 switch. Andar jaaye bina batao kaun si switch kis bulb ko jalaata hai?', a: 'Ek switch on karke 10 min wait, phir off — garam bulb = pehla switch 💡' },
];

let pending = null; // {q, answer}

export function newQuiz(opts = {}) {
  const { now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const item = TRIVIA[nowTs % TRIVIA.length];
  pending = { answer: item.answer };
  return `🎉 *Trivia time!*\n${item.q}\n${item.options.join('\n')}\n\nJawab: \`/fun answer <n>\``;
}

export function answerQuiz(n) {
  if (!pending) return '🎉 Pehle sawal lo: `/fun quiz`';
  const given = Number(n);
  const right = pending.answer;
  const ok = given === right;
  pending = null;
  return ok ? '🎉 *Sahi jawab!* 🏆 Naya: `/fun quiz`' : `😅 Galat! Sahi jawab *${right}* tha. Naya try: \`/fun quiz\``;
}

export function newRiddle(opts = {}) {
  const { now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const item = RIDDLES[nowTs % RIDDLES.length];
  pending = { riddle: true };
  return `🤔 *Riddle:* ${item.q}\n\nJawab batao seedha!`;
}

export function checkRiddle(text) {
  if (!pending?.riddle) return null;
  pending = null;
  return `🤔 Hmm, mera jawab tha: ${RIDDLES[0].a} (riddles ki list me alag-alag hai — dil se accept 😄)`;
}
