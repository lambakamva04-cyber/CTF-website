// Terms and privacy policy, versioned.
//
// Kept as data rather than prose in a component so the version accepted by each
// user can be recorded and compared later. Bump the version whenever the
// substance changes — an acceptance record is only meaningful if it points at
// the text that was actually agreed to.
//
// These are a working draft written to describe what the platform genuinely
// does. They are not a substitute for review by someone qualified in South
// African law, particularly on POPIA obligations toward callers, who are not
// users of this platform and never agreed to anything.

export const TERMS_VERSION = '2026-08-07';
export const PRIVACY_VERSION = '2026-08-07';

export interface LegalSection {
  heading: string;
  body: string[];
}

export interface LegalDocument {
  title: string;
  version: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
}

export const TERMS: LegalDocument = {
  title: 'Terms of Service',
  version: TERMS_VERSION,
  updated: '7 August 2026',
  intro:
    'These terms govern your use of the Cut Through Faster control platform — the dashboard where you watch your AI receptionist work, read call transcripts, and take calls over. By signing in you agree to them.',
  sections: [
    {
      heading: '1. The service',
      body: [
        'Cut Through Faster provides an AI receptionist that answers your business telephone, and this platform, where you see those calls as they happen and afterwards.',
        'The platform depends on third parties — a voice provider that carries the calls, and Cloudflare, which hosts the service and stores the data. An outage at either can interrupt the dashboard. Your telephone line is not affected by a dashboard outage.',
      ],
    },
    {
      heading: '2. Your account',
      body: [
        'An organization account is created on request and becomes active once we approve it. Until then you can sign in but will not see call data.',
        'You are responsible for who you invite. An owner can add logins, set roles, and remove access at any time, and should remove people promptly when they leave.',
        'Keep your sign-in credentials to yourself. Tell us immediately if you believe an account has been compromised.',
      ],
    },
    {
      heading: '3. Taking over and ending calls',
      body: [
        'The platform lets your staff transfer a live call to a telephone, and end a call in progress. Both act on a real conversation with a real person, immediately and irreversibly.',
        'You are responsible for how your staff use these controls.',
      ],
    },
    {
      heading: '4. What we measure for billing',
      body: [
        'We record counts of calls answered, appointments booked, and call minutes for your organization, and we use those counts to calculate what you are billed.',
        'These counts are visible to Cut Through Faster staff. Caller names, telephone numbers, transcripts and recordings are not included in what our billing view shows.',
        'You can ask us for the figures behind any invoice.',
      ],
    },
    {
      heading: '5. Acceptable use',
      body: [
        'Do not use the platform to break the law, to record or intercept calls where you are not permitted to, or to attempt to reach another organization’s data.',
        'Do not attempt to disrupt the service, circumvent its access controls, or use automated means to extract data in bulk.',
      ],
    },
    {
      heading: '6. Suspension',
      body: [
        'We may suspend an account for non-payment, for a breach of these terms, or where continuing would put other clients or callers at risk. Where circumstances allow, we will tell you first.',
        'Suspension withdraws access; it does not delete your data.',
      ],
    },
    {
      heading: '7. Availability and liability',
      body: [
        'We work to keep the platform available but do not guarantee uninterrupted service, and it is provided without warranties beyond those the law requires.',
        'Nothing here limits liability that cannot lawfully be limited.',
      ],
    },
    {
      heading: '8. Ending the agreement',
      body: [
        'You may stop using the platform at any time and ask us to close your account.',
        'On closure we delete or irreversibly anonymise your call data within 90 days, except where we are required to keep records for longer.',
      ],
    },
    {
      heading: '9. Changes',
      body: [
        'We may update these terms. Material changes will be shown to you when you next sign in, and continuing to use the platform means accepting the revised version.',
      ],
    },
    {
      heading: '10. Governing law',
      body: ['These terms are governed by the laws of the Republic of South Africa.'],
    },
  ],
};

export const PRIVACY: LegalDocument = {
  title: 'Privacy Policy',
  version: PRIVACY_VERSION,
  updated: '7 August 2026',
  intro:
    'This explains what the Cut Through Faster control platform collects, why, and who can see it. It covers two different groups of people: the staff who sign in, and the members of the public who telephone your business.',
  sections: [
    {
      heading: 'About people who sign in',
      body: [
        'We store your name, email address, role, and an optional mobile number used to transfer calls to you.',
        'If you sign in with Google we receive your email address, Google account identifier, and name. We never receive your Google password.',
        'If you sign in with a password we store only a salted PBKDF2 hash of it, never the password itself.',
        'We record sign-ins, call takeovers, calls ended, and changes to logins, together with the IP address they came from. This is a security record: it is how an account compromise can be investigated.',
      ],
    },
    {
      heading: 'About people who telephone your business',
      body: [
        'When someone calls your business, we store their telephone number, the name they give, a transcript of the conversation, a summary, the outcome, and where your voice provider supplies one, an audio recording.',
        'These callers are not users of this platform and have not agreed to this policy. Telling them that calls are recorded and transcribed, and having a lawful basis for it, is your responsibility as the business they called. Your AI receptionist can be configured to say so at the start of a call, and we recommend it.',
        'Cut Through Faster staff do not have a routine view of caller names, telephone numbers, transcripts or recordings.',
      ],
    },
    {
      heading: 'What Cut Through Faster can see',
      body: [
        'For billing we look at counts only: calls answered, appointments booked, and call minutes, per organization per month.',
        'That view does not include caller names, telephone numbers, transcripts, recordings, or the content of any conversation.',
        'If you report a fault that cannot be diagnosed from counts alone, we will ask for your permission before looking at anything more.',
      ],
    },
    {
      heading: 'Why we hold it',
      body: [
        'To provide the service you have asked for — showing you your calls and letting you take them over.',
        'To bill you accurately, which is why the counts described above are collected.',
        'To keep the platform secure, which is why sign-ins and sensitive actions are logged.',
      ],
    },
    {
      heading: 'Who else is involved',
      body: [
        'Cloudflare hosts the platform and stores its data, in a database located in Western Europe.',
        'Your voice provider carries the calls and produces the transcripts, and holds recordings on their own systems under their own terms.',
        'Google, if you choose to sign in with it, confirms your identity to us.',
        'We do not sell your data or share it for advertising.',
      ],
    },
    {
      heading: 'How long we keep it',
      body: [
        'Call records and transcripts are retained while your account is open, and deleted or irreversibly anonymised within 90 days of closure.',
        'Security logs are kept for 12 months.',
        'Expired sessions and sign-in attempt records are cleared automatically each night.',
      ],
    },
    {
      heading: 'Your rights',
      body: [
        'Under POPIA you may ask what we hold about you, ask for it to be corrected, and in many cases ask for it to be deleted.',
        'If a caller makes such a request to you about their own data, contact us and we will help you meet it.',
        'Requests can be sent to the contact address on cutthroughfaster.com.',
      ],
    },
    {
      heading: 'Security',
      body: [
        'Access to each organization is separated: every request for call data is restricted to the organization of the person making it.',
        'Sign-in sessions are held in cookies that scripts cannot read, and only a hash of each session token is stored, so the database cannot be used to impersonate anyone.',
        'Sign-in attempts and requests are rate limited.',
        'No system is perfectly secure. If a breach affects your data we will notify you and the Information Regulator as POPIA requires.',
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS = { terms: TERMS, privacy: PRIVACY } as const;
