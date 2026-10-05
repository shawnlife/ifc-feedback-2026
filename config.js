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
    banner: 'assets/brand/banner.jpg'   // venue photo strip under the logos ('' to hide it)
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
      // One star rating PER SPEAKER, using the names in the session list
      // ("How would you rate the speaker, Jane Doe?"). Sessions without named
      // speakers get the single general question below instead.
      column: 'Speakers (1-5)',               // average of this person's speaker ratings
      detailColumn: 'Speaker ratings',        // each one: "Jane Doe: 4; John Roe: 5"
      type: 'speakers',
      label: 'How would you rate the speaker, {name}?',
      generalLabel: 'How would you rate the speaker(s)?',
      low: 'Poor', high: 'Excellent'
    },
    {
      column: 'Relevance (1-5)',
      type: 'rating',
      label: 'How relevant was it to your work?',
      low: 'Not at all', high: 'Very'
    },
    {
      column: 'Learned something new',
      type: 'choice',
      label: 'Did you learn anything new?',
      options: ['Yes', 'No', 'Not sure']
    },
    {
      column: 'Anything else',
      type: 'text',
      label: 'Anything else you would like to add?',
      placeholder: 'Optional'
    }
  ],

  // OPTIONAL CONTACT (attendee form only): a tick box at the end. Only when ticked are a
  // name and email asked for and sent; everyone else stays anonymous. Shown on the
  // dashboard's Follow-ups tab, never in comments, scorecards or Word exports.
  // Set to null to remove it.
  contactOptIn: {
    label: 'I\'d like someone from the IFC team to contact me about this session',
    help: 'Optional. Your name and email go only to the IFC team, with this response, so they can get in touch.'
  },

  // SESSION LEADER FORM (at /sessionleader). Same rules as above.
  // type 'name' = a one-line answer (remembered on the Session Leader's phone for next time).
  leaderQuestions: [
    {
      column: 'Session Leader name',
      type: 'name',
      label: 'Your name',
      required: true
    },
    {
      column: 'Session Leader: Overall (1-5)',
      type: 'rating',
      label: 'Overall rating',
      help: 'How would you rate this session overall? Was it insightful? Did people seem to enjoy it? Would you recommend it to other delegates?',
      low: 'Poor', high: 'Excellent',
      required: true
    },
    {
      column: 'Session Leader: Audience engagement (1-5)',
      type: 'rating',
      label: 'Audience engagement',
      help: 'Did the audience seem engaged in the topic? Was there good discussion and questions? Were the delegates checked out?',
      low: 'Checked out', high: 'Very engaged',
      required: true
    },
    {
      column: 'Session Leader: Content clarity (1-5)',
      type: 'rating',
      label: 'Content clarity',
      help: 'How clear was the content? Did the speakers communicate effectively? Was there too much information or not enough?',
      low: 'Unclear', high: 'Very clear',
      required: true
    },
    {
      column: 'Session Leader: Key issues',
      type: 'text',
      label: 'Key issues',
      help: 'Any key issues that need to be addressed about this session, the speakers, the topics, etc.',
      placeholder: 'Optional'
    },
    {
      column: 'Session Leader: Final comments',
      type: 'text',
      label: 'Final comments',
      help: 'Did anything of note happen (room was packed, lots of delegates left in the middle, a heated debate)? Did a speaker do an exceptionally good job? Did you learn something that should be explored further? Your overall thoughts in a sentence or two.',
      required: true
    }
  ]
};
