import { lessonModuleIntroSpeech, lessonModuleGreeting } from '../src/utils/greetings';
import { cleanSpeechText } from '../src/utils/textClean';

const module1 = {
  title: 'Subject-Verb Agreement with Indefinite Pronouns',
  focusArea: "Subject-verb agreement with plural/indefinite subjects like 'some'",
  exampleError: 'some uses mobile phone for entertainment, some for work purpose',
  errorAnalysis:
    "'Some' here refers to a plural, indefinite group of people, so it needs the plural verb 'use', not 'uses'. The noun 'mobile phone' also needs to be plural ('phones') since it refers to a general category, not one device.",
  correction: 'some use mobile phones for entertainment, some for work purposes',
  practiceDrill: {
    prompt:
      "Say the corrected version aloud: 'some use mobile phones for entertainment, some for work purposes.' Then make one new sentence using 'some... some...' with correct subject-verb agreement.",
  },
};

const g = lessonModuleGreeting({
  moduleTitle: module1.title,
  nickname: 'Mahi',
  practicePrompt: module1.practiceDrill.prompt,
  errorAnalysis: module1.errorAnalysis,
  correction: module1.correction,
});
console.log('DISPLAY (bubble):', g.display);
console.log();
console.log('SPOKEN (raw)     :', g.spoken);
console.log();
const cleaned = cleanSpeechText(g.spoken);
console.log('SPOKEN (cleaned) :', cleaned);
console.log();
console.log('--- what the cleaner removed ---');
console.log('removed:', JSON.stringify(g.spoken.replace(cleaned, '')) || '(nothing)');
