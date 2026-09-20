// Character assets for Seren
import greetingImg from './images/seren_greeting_1787492961283.jpg';
import speakingImg from './images/seren_speaking_1787492978470.jpg';
import listeningImg from './images/seren_listening_1787492997307.jpg';
import encouragingImg from './images/seren_encouraging_1787493011784.jpg';
import profileImg from './images/seren-profile.png';
import userImg from './images/user.jpg';
import { SerenMood } from '../types';
import { MOOD_STATUS_TEXT } from '../utils/serenMood';

export const SEREN_IMAGES: Record<SerenMood, string> = {
  greeting: greetingImg,
  speaking: speakingImg,
  listening: listeningImg,
  encouraging: encouragingImg,
  evaluating: listeningImg,
  celebrating: encouragingImg,
};

// Fixed profile avatars for the messaging interface: Seren's profile picture
// and the learner's photo (uploaded by the user from the assets folder).
export const SEREN_PROFILE_IMAGE = profileImg;
export const USER_AVATAR_IMAGE = userImg;

// Status text is owned by the central mood system (src/utils/serenMood.ts).
export const SEREN_STATUS_TEXT: Record<SerenMood, string> = MOOD_STATUS_TEXT;
