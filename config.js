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
      low: 'Poor', high: 'Excellent',
      required: true                          // every speaker must be rated
    },
    {
      column: 'Relevance (1-5)',
      type: 'rating',
      label: 'How relevant was it to your work?',
      low: 'Not at all', high: 'Very',
      required: true
    },
    {
      column: 'Learned something new',
      type: 'choice',
      label: 'Did you learn anything new?',
      options: ['Yes', 'No', 'Not sure'],
      required: true
    },
    {
      column: 'Anything else',
      type: 'text',
      label: 'Anything else you would like to add?',
      placeholder: 'Optional'
    }
  ],

  // OPTIONAL CONTACT (attendee form only): a tick box at the end. Only when ticked are a
  // name and email asked for and sent; everyone else stays anonymous. Shown with that
  // response in the dashboard's Comments tab, never in scorecards or Word exports.
  // Set to null to remove it.
  contactOptIn: {
    label: 'I\'m happy to leave my contact details and am open to the IFC team following up on my feedback',
    help: 'Optional. Only the IFC team sees your name and email.'
  },

  // IFC ONLINE FORM (at /online): the moderator posts ifc2026survey.com/online in the
  // livestream chat. It only lists these sessions (IDs from the Sessions tab) and asks
  // "Is this the session you just watched?" by time. Answers get Format = Online and
  // show on the dashboard's IFC Online tab, separate from in-person feedback.
  online: {
    title: 'IFC Online feedback',
    sessions: ['KEY-OPEN', '1WS11', '2WS6', '3WS10', '4WS3', '5WS14', '6WS7', '7WS12', 'KEY-CLOSE']
  },

  // MASTERCLASS PICKS (at /allocations): Session Leaders choose their top 3 masterclasses
  // to lead, before the conference. Answers go to the "Masterclass picks" tab and the
  // Sheet only (never the dashboard). "deadline" is shown on the page ('' to hide it).
  masterclassPicks: {
    deadline: '',
    // Session Leaders (first names), shown as a dropdown in alphabetical order
    leaders: ['Hollie', 'Rachael', 'Mireille', 'Tsungai', 'Lianne', 'Alice', 'Jordan', 'Sylvia', 'Bongiwe', 'Lucy',
              'Danielle', 'Yolanda', 'Sarah', 'Filipa', 'Isla', 'Dimitri', 'Astrid', 'In\u00eas', 'Michelle', 'Noah'],
    list: [
      { title: 'Building Growth That Doesn\'t Break Trust',
        by: 'Lindsay Marino Long (Faircom New York), Ishmam Rahman (International Rescue Committee)',
        about: 'Bringing AI into fundraising work without losing the trust and relationships that growth depends on.',
        url: 'https://www.resource-alliance.org/session/building-growth-doesnt-break-trust-mc/' },
      { title: 'Leading Fundraising Systems in Uncertainty',
        by: 'Damian Chapman (Fundraiser In The Room), Luke Genevrier-Mallett (Ben)',
        about: 'Diagnosing what is holding a fundraising operation back, and redesigning systems and leadership that can cope with today.',
        url: 'https://www.resource-alliance.org/session/leading-fundraising-systems-uncertainty-mc/' },
      { title: 'Power, Wealth, Philanthropy\u2026 and Justice?',
        by: 'Rowena Estwick (Ten Years\' Time), Dee Brecker (Ten Years\' Time, Ginko Coaching & Consulting)',
        about: 'Putting equity and anti-racism into practice in fundraising, and what racial and economic justice asks of philanthropy.',
        url: 'https://www.resource-alliance.org/session/power-wealth-philanthropy-justice-mc/' },
      { title: 'Leading Long-Term Transformation',
        by: 'Yadharshini Selvaraj (Tea Leaf Trust), Tim Pare (Tea Leaf Trust), Sutharshan Visventhan (The Cookstove Project)',
        about: 'Leading change that shifts power and delivers lasting results for communities, through the messy, non-linear reality of it.',
        url: 'https://www.resource-alliance.org/session/change-management-mc/' },
      { title: 'Your Digital Engine Room',
        by: 'Sarah Crowhurst (Hynt), JoAnne O\'Donovan (Dogs Trust Ireland), Joshua Leigh (Hynt)',
        about: 'Hands-on digital fundraising: social media, email, websites and the tools that tie them together.',
        url: 'https://www.resource-alliance.org/session/digital-engine-room-mc/' },
      { title: 'Audience-Led Decision-Making',
        by: 'Kit Lewis (Aha Agency), Alice Gayner (Comic Relief), Rosie O\'Connor (VSO)',
        about: 'Making quicker, better decisions by starting from audience insight, without getting stuck in analysis.',
        url: 'https://www.resource-alliance.org/session/audience-led-decision-making-mc/' },
      { title: 'Major Donor Fundraising in Complex Times',
        by: 'Konstantina Papadimitriou (Inuksuk Consulting), Vincent Duckworth (ViTreo Group)',
        about: 'How major donors weigh risk, governance and credibility, and how to earn their confidence.',
        url: 'https://www.resource-alliance.org/session/major-donor-complex-mc/' },
      { title: 'Great Fundraising Leadership',
        by: 'Colin Skehan (Revolutionise International), Jayne George (RNLI)',
        about: 'The main barriers to fundraising growth, and the leadership behaviours that unlock it.',
        url: 'https://www.resource-alliance.org/session/great-fundraising-leadership-mc/' },
      { title: 'Alternative Financing Models for Impact',
        by: 'Ruth Davison (SASC Trust), Leana de Beer (WaFunda), Richard Hawkes (Oxfam)',
        about: 'Funding beyond traditional grants: the growing range of capital open to mission-driven organisations.',
        url: 'https://www.resource-alliance.org/session/alternative-financing-models-impact-mc/' },
      { title: 'From Data Overwhelm to Strategic Impact',
        by: 'Erin Hamalainen (Slingshot Data), Fiona McPhee (Revolutionise)',
        about: 'Turning fundraising data into decisions, and using analytics to show value.',
        url: 'https://www.resource-alliance.org/session/data-driven-investment-mc/' },
      { title: 'The AI-Ready Fundraiser',
        by: 'Saarah Abdeen (ActionAid Australia), Andrew Sabatino (Donor Republic), Natalie Gibbs (Cancer Council Victoria)',
        about: 'An honest look at AI in fundraising: what genuinely helps, and what is hype.',
        url: 'https://www.resource-alliance.org/session/artificial-intelligence-mc/' }
    ]
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
