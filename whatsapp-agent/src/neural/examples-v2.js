// Curated public examples for v2. Evaluation fixtures are intentionally NOT
// imported here or in the trainer. No runtime/private conversations ship.
const groups = {
  greeting: [
    'morning dost kaise chal raha sab', 'hello friend ready for a chat', 'hey how have you been lately',
    'salaam dost kaisa hai', 'good afternoon friend hope you are well', 'namaskar dost sab kushal',
    'arey hello bahut din baad', 'kya haal dost sab theek chal raha', 'नमस्ते दोस्त कैसे हो', 'नमस्कार मित्र',
  ],
  gratitude: [
    'much appreciated that worked perfectly', 'really grateful for your support', 'excellent answer thank you very much',
    'bahut acchi madad ki tumne shukriya', 'mera kaam ho gaya thanks again', 'bye take care we will chat later',
    'tumhari mehnat ke liye dhanyavaad', 'i appreciate the clear explanation', 'धन्यवाद बहुत मदद हुई', 'शुक्रिया दोस्त',
  ],
  factual: [
    'which planet is closest to the sun', 'tell me the full form of html', 'canada ki rajdhani kya hai',
    'kaunsa janwar sabse tez daudta hai', 'kitne continent hain duniya me', 'what is the chemical symbol for gold',
    'who first measured the gravitational constant', 'which year was the united nations founded',
    'भारत की राजधानी क्या है', 'भारत के पहले राष्ट्रपति कौन थे',
  ],
  comparison: [
    'contrast tcp and quic connection setup', 'weigh the pros and cons of renting versus buying',
    'compare golang and rust for servers', 'which has better battery life oled or lcd',
    'mere liye laptop aur desktop me se kya better rahega', 'explain the differences between precision and recall',
    'compare the advantages of trains and flights', 'numpy aur pandas ke beech antar kya hai',
    'एसएसडी और हार्ड डिस्क की तुलना करो', 'चाय और कॉफी में अंतर बताओ',
  ],
  howto: [
    'give instructions for setting up a firewall', 'steps to reset a forgotten account password',
    'guide me through installing rust on linux', 'how can i secure my home router',
    'ssh service enable karne ke steps batao', 'naya laptop configure karne ka tareeka',
    'how do i make a bootable usb safely', 'python package install karna sikhao commands ke saath',
    'लिनक्स कैसे इंस्टॉल करें', 'बैकअप कैसे बनाना है',
  ],
  code: [
    'implement a rust iterator that yields fibonacci numbers', 'refactor this java class to remove duplication',
    'debug a null pointer exception in kotlin', 'write a typescript interface for a user profile',
    'a bash script chahiye files rename karne ke liye', 'implement a queue in c with tests',
    'give working javascript code for retry with backoff', 'create a fastapi route that validates input',
    'पाइथन कोड लिखो फाइल पढ़ने के लिए', 'यह कोड ठीक करो',
  ],
  explain: [
    'walk me through the intuition behind gradient descent', 'what makes a magnet attract iron explain simply',
    'describe why transactions need isolation', 'cache invalidation mushkil kyun hai samjhao',
    'how do electric motors turn electricity into motion', 'overfitting hota kyun hai detail me batao',
    'tell me how a compiler turns source into machine instructions', 'why do seasons change on earth',
    'गुरुत्वाकर्षण समझाओ', 'न्यूरल नेटवर्क कैसे काम करता है समझाओ',
  ],
  emotional: [
    'i am overwhelmed with deadlines and need encouragement', 'nervous about meeting new people',
    'it has been a rough day and i feel drained', 'alone hoon aur baat karne ka mann hai',
    'yaar motivation bilkul khatam si lagti hai', 'bahut pressure feel kar raha hoon',
    'i feel anxious and cannot focus on work', 'exhausted from studying all week',
    'आज बहुत उदास हूँ', 'मैं परेशान हूँ दोस्त',
  ],
  creative: [
    'compose a verse celebrating spring mornings', 'draft a funny wedding toast for my cousin',
    'suggest imaginative names for a bookstore', 'write a heartfelt good luck wish for my friend',
    'ek choti detective kahani banao', 'nayi chai ki dukaan ke naam suggest kar',
    'create a slogan for an eco friendly brand', 'write a warm message for our anniversary',
    'बारिश पर कविता लिखो', 'एक मजेदार कहानी सुनाओ',
  ],
  math: [
    'find the second derivative of sine x', 'calculate the area of a circle with radius nine',
    'evaluate forty percent of three hundred', 'find the lcm of fourteen and twenty one',
    'probability of rolling two sixes with fair dice', 'simple interest 5000 ka 6 percent par teen saal',
    'solve x squared minus nine equals zero', 'triangle ki height 8 aur base 5 toh area kitna',
    'सौ का बीस प्रतिशत की गणना करो', '25 और 75 का योग कितना है',
  ],
  personal: [
    'my preferred language is hinglish please remember', 'remember that i am allergic to peanuts',
    'save my preferred wake up time as six am', 'what do you remember about my hobbies',
    'meri favourite programming language rust hai', 'yaad rakh mujhe dark mode pasand hai',
    'do you know where i like to go on holiday', 'mere interests ke baare me tumhe kya yaad hai',
    'मेरा नाम राहुल है याद रखना', 'मुझे चाय पसंद है याद रखो',
  ],
  misc_chat: [
    'would you rather explore an ocean or a desert', 'do you believe technology makes people happier',
    'lets chat about life for a bit', 'tell a ridiculous joke about vegetables',
    'random gupshup karte hain dost', 'tumhari opinion me remote work ka future kya hoga',
    'pick a fun topic for casual conversation', 'koi halka phulka joke suna de',
    'आज बस बातें करते हैं', 'तुम्हें क्या लगता है भविष्य कैसा होगा',
  ],
};
export const V2_EXAMPLES = Object.entries(groups).flatMap(([label, texts]) => texts.map((t) => ({ t, label })));
