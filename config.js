/*
 * IFC 2026 SESSION FEEDBACK: SETTINGS
 * ===================================
 * This is the only file you should need to edit. Change the text between the
 * quote marks, keep the commas and brackets exactly as they are.
 *
 * The SESSION LIST is NOT in here. It lives in the Google Sheet ("Sessions" tab)
 * and the form picks up changes within about a minute.
 */
window.IFC_CONFIG = {

  // The web app address from Google Apps Script (ends in /exec).
  // Leave it empty ('') to run in DEMO MODE: the form uses the session list in
  // sessions-ifc2026.csv and does not save anything.
  apiUrl: 'https://script.google.com/macros/s/AKfycbxG_FLqQRg2gsGxfDqIVjpvoBHTuIDDzevORXNPwPOcuFy7MwWbfq6V6tloZkZh38DbZg/exec',

  // FIREBASE (the main way responses come in; built to take hundreds at the same moment).
  // From the Firebase console: Project settings > General > Your apps > Web app config.
  // Leave empty to send straight to the Google Sheet instead.
  firebase: {
    projectId: 'ifc-feedback-2026',
    apiKey: 'AIzaSyBYFk7rSrwMAEFfzQntnyRawGOLISPasb0'
  },

  eventName: 'IFC 2026',

  // BRANDING: put the image files in assets/brand/ and write their names here.
  // Leave any of them empty ('') to hide it.
  brand: {
    logoLeft: 'assets/brand/ifc-2026-logo-white.webp',
    logoLeftAlt: 'IFC 2026',
    logoRight: 'assets/brand/presented-by-resource-alliance-white.webp',
    logoRightAlt: 'Presented by the Resource Alliance',
    banner: ''         // e.g. 'assets/brand/banner.jpg' (wide image, shown short on phones)
  },

  // Session times in the Sheet are local conference time. This is what lets the
  // form show "just finished" sessions first. Do not change during the event.
  timezone: 'Europe/Amsterdam',

  // FEEDBACK QUESTIONS
  // type: 'rating' = 1 to 5 stars, 'choice' = pick one option, 'text' = typed answer
  // required: true means the person must answer before sending.
  // "column" is the heading used in the Google Sheet. If you change a column name
  // mid-event, the Sheet starts a NEW column for it (old answers stay put).
  questions: [
    {
      column: 'Overall (1-5)',
      type: 'rating',
      label: 'Overall, how would you rate this session?',
      low: 'Poor', high: 'Excellent',
      required: true
    },
    {
      column: 'Speakers (1-5)',
      type: 'rating',
      label: 'How would you rate the speaker(s)?',
      low: 'Poor', high: 'Excellent'
    },
    {
      column: 'Relevance (1-5)',
      type: 'rating',
      label: 'How relevant was it to your work?',
      low: 'Not at all', high: 'Very'
    },
    {
      column: 'Will apply',
      type: 'choice',
      label: 'Will you put something from this session into practice?',
      options: ['Yes, definitely', 'Maybe', 'No']
    },
    {
      column: 'Key takeaway',
      type: 'text',
      label: 'What is your key takeaway?',
      placeholder: 'Optional'
    },
    {
      column: 'Suggestions',
      type: 'text',
      label: 'Anything that would have made it better?',
      placeholder: 'Optional'
    }
  ]
};
