// The demo's privacy policy, kept as data in the same shape as the control
// platform's (app/shared/legal.ts), so the two read as one company's policies.
//
// Written to describe what this code actually does — the two Supabase tables in
// migrations/0001_init.sql, the Vapi web call in DemoPanel.tsx, the Worker on
// Cloudflare — and nothing it does not. Change it whenever those change. It is a
// working draft, not a substitute for review by someone qualified in South
// African law.

export const PRIVACY_VERSION = '2026-09-26';

/** Same inbox as the control platform's Information Officer. */
export const PRIVACY_CONTACT = 'privacy@cutthroughfaster.com';

export interface PolicySection {
  heading: string;
  body: string[];
}

export interface SubProcessor {
  name: string;
  role: string;
  location: string;
}

/**
 * Everyone who handles information from this page, named, as the platform's
 * policy does: "a voice provider" would give nobody a way to check who holds a
 * recording of their voice.
 */
export const DEMO_SUB_PROCESSORS: SubProcessor[] = [
  {
    name: 'Cloudflare, Inc.',
    role: 'Hosts this page. Handles your IP address to deliver it and keeps short-lived technical logs.',
    location: 'Global network',
  },
  {
    name: 'Supabase, Inc.',
    role: 'Stores the practice details shown on the page and the record of what happened on it.',
    location: 'Ireland (European Union)',
  },
  {
    name: 'Vapi',
    role: 'Runs the conversation with Hope and keeps its recording and transcript, using speech-recognition, AI language-model and voice providers to understand and answer you.',
    location: 'United States',
  },
];

export const DEMO_PRIVACY: {
  title: string;
  version: string;
  updated: string;
  intro: string;
  sections: PolicySection[];
} = {
  title: 'Privacy Policy',
  version: PRIVACY_VERSION,
  updated: '26 September 2026',
  intro:
    'This covers the Hope demo pages: the personal link we sent your practice, and the conversation you can have on it with Hope, our AI receptionist. It explains what we collect, why, who handles it, and what you can ask us to do about it.',
  sections: [
    {
      heading: 'Who we are',
      body: [
        'Cut Through Faster ("CTF") is a South African business that provides AI receptionists. We decide what is collected on these pages and why, so under the Protection of Personal Information Act (POPIA) we are the responsible party for it.',
        `Questions and requests go to our Information Officer at ${PRIVACY_CONTACT}.`,
      ],
    },
    {
      heading: 'What we held before you opened the link',
      body: [
        'To prepare your demo we put together a short profile of your practice from publicly available business information, such as its website and online business listings: its name, its suburb, the services it offers and its opening hours.',
        'That profile is what the page shows under "What Hope already knows", and it is all Hope is told about your practice.',
      ],
    },
    {
      heading: 'What the page records',
      body: [
        'When the page is opened, and when a call starts or ends, we record that it happened, when, how long the call lasted and how it ended, whether the microphone was refused, and the kind of browser and device you used (the "user agent" your browser sends).',
        'We do not record your IP address ourselves. Cloudflare, which hosts the page, has to handle it to deliver the page to you, and keeps short-lived technical logs.',
        'The page uses no advertising or tracking cookies.',
      ],
    },
    {
      heading: 'The conversation with Hope',
      body: [
        'When you tap "Talk to Hope", your browser asks to use your microphone and sends what you say to Vapi, the voice platform that runs the conversation. Vapi passes the audio and text to the speech-recognition, AI language-model and voice providers it uses, so that Hope can understand you and answer.',
        'Vapi keeps a recording and a transcript of the conversation. We can listen to and read them.',
        'The microphone is used only during the call, and each link allows one conversation of up to three minutes.',
        'Hope is a demonstration. Please do not give her real patient details or anyone else’s personal information: whatever is said is recorded.',
      ],
    },
    {
      heading: 'Why we use it',
      body: [
        'To run the demo: to show Hope your practice’s details, and to limit each link to one conversation.',
        'To see whether the demo works — which links are opened, which calls connect, where they fail — and to improve Hope from what callers ask her.',
        'To follow up with your practice about CTF. You can tell us at any time to stop, and we will.',
        'We do not sell this information or share it for advertising.',
      ],
    },
    {
      heading: 'Who else handles it',
      body: [
        ...DEMO_SUB_PROCESSORS.map(
          (processor) => `${processor.name} — ${processor.role} Located in: ${processor.location}.`,
        ),
        'If you book a call with us, you do that on our booking page (currently Calendly), which has its own privacy policy.',
      ],
    },
    {
      heading: 'Sending information outside South Africa',
      body: [
        'The records are stored in Ireland and the conversation is handled in the United States, so this information leaves South Africa.',
        'Section 72 of POPIA allows this where the recipient is bound by protections substantially similar to those POPIA sets. We rely on each provider’s data processing terms for that.',
      ],
    },
    {
      heading: 'How long we keep it',
      body: [
        'We keep the practice profile, the page records and the conversation only for as long as we need them to follow up with your practice about CTF, and we delete them when you ask us to.',
      ],
    },
    {
      heading: 'Your rights',
      body: [
        'Under POPIA you may ask what we hold about you or your practice, ask us to correct it, and ask us to delete it. You may also object to our contacting you, and we will stop.',
        `Send requests to ${PRIVACY_CONTACT}. If you are unhappy with our answer, you may complain to the Information Regulator of South Africa.`,
      ],
    },
    {
      heading: 'Security',
      body: [
        'Your browser never talks to our database directly: every read and write goes through our own server, and a demo link cannot be used to look up any other practice.',
        'Demo pages are hidden from search engines, so a practice’s name does not appear in search results.',
        'No system is perfectly secure. If a breach affects information we hold about you, we will tell you and the Information Regulator, as section 22 of POPIA requires.',
      ],
    },
    {
      heading: 'Changes',
      body: [
        'If what these pages collect changes, we will update this policy and the date at the top of it.',
      ],
    },
  ],
};
