// Terms, privacy policy and operator agreement, versioned.
//
// Kept as data rather than prose in a component so the version each user
// accepted can be recorded and compared later. Bump the version whenever the
// substance changes — an acceptance record is only meaningful if it points at
// the text that was actually agreed to.
//
// A working draft written to describe what the platform genuinely does. It is
// not a substitute for review by someone qualified in South African law. Two
// things in particular need a practitioner's eye: the operator agreement is the
// instrument POPIA section 72 relies on for sending personal information out of
// the country, and callers are not users of this platform and have agreed to
// nothing at all.

export const TERMS_VERSION = '2026-08-12';
export const PRIVACY_VERSION = '2026-08-11';
export const OPERATOR_VERSION = '2026-08-11';

export type LegalDocumentId = 'terms' | 'privacy' | 'operator';

/**
 * The Information Officer POPIA requires every responsible party to appoint and
 * register with the Information Regulator. Registration is a form submitted to
 * the Regulator — it cannot be done in code, and until it is done these details
 * are a promise the company has not yet kept.
 */
export const INFORMATION_OFFICER = {
  name: 'To be appointed',
  email: 'privacy@cutthroughfaster.com',
  registeredWithRegulator: false,
} as const;

/** How quickly a breach is reported. Stated as a commitment, not an aspiration. */
export const BREACH_NOTIFICATION_HOURS = 72;

export interface SubProcessor {
  name: string;
  role: string;
  location: string;
  handlesCallerData: boolean;
}

/**
 * Everyone who touches client or caller data. Named explicitly: a policy that
 * refers to "a voice provider" gives a client no way to check who is holding
 * their callers' recordings.
 */
export const SUB_PROCESSORS: SubProcessor[] = [
  {
    name: 'Cloudflare, Inc.',
    role: 'Hosts the platform and stores call records, transcripts and account data.',
    location: 'Western Europe (database), global edge network',
    handlesCallerData: true,
  },
  {
    name: 'Vapi',
    role: 'Carries the telephone calls, produces transcripts, and stores audio recordings.',
    location: 'United States',
    handlesCallerData: true,
  },
  {
    name: 'Google LLC',
    role: 'Confirms the identity of staff who choose to sign in with Google.',
    location: 'United States',
    handlesCallerData: false,
  },
];

export interface LegalSection {
  heading: string;
  body: string[];
  /**
   * Renders the section as a bordered, visually distinct block.
   *
   * Not decoration. Section 49 of the Consumer Protection Act requires that a
   * term limiting a supplier's liability, or asking the customer to indemnify
   * or assume risk, be drawn to the customer's attention in a conspicuous
   * manner before they agree. A limitation buried in the middle of a wall of
   * grey text is exactly what that section is aimed at.
   */
  emphasis?: boolean;
}

export interface LegalDocument {
  id: LegalDocumentId;
  title: string;
  version: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
}

export const TERMS: LegalDocument = {
  id: 'terms',
  title: 'Terms of Service',
  version: TERMS_VERSION,
  updated: '12 August 2026',
  intro:
    'These terms govern your use of the Cut Through Faster control platform — the dashboard where you watch your AI receptionist work, read call transcripts, and take calls over. By signing in you agree to them. Sections 9 and 10 limit what you can recover from us and set out when you cover us instead; they are marked out on this page and you should read them before you accept.',
  sections: [
    {
      heading: '1. The service',
      body: [
        'Cut Through Faster provides an AI receptionist that answers your business telephone, and this platform, where you see those calls as they happen and afterwards.',
        'The platform depends on third parties, named in full in the Privacy Policy and the Operator Agreement. An outage at any of them can interrupt the dashboard. Your telephone line is not affected by a dashboard outage.',
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
      heading: '3. Your obligations to your callers',
      body: [
        'You are the responsible party for the personal information of the people who telephone your business. We are your operator, and we process it on your instruction.',
        'You must have a lawful basis under POPIA for recording and transcribing those calls, and you must tell callers it is happening. Your AI receptionist can be configured to announce it at the start of every call, and we strongly recommend that you do so.',
        'The Operator Agreement sets out this division of responsibility in full and forms part of these terms.',
      ],
    },
    {
      heading: '4. Taking over and ending calls',
      body: [
        'The platform lets your staff transfer a live call to a telephone, and end a call in progress. Both act on a real conversation with a real person, immediately and irreversibly.',
        'You are responsible for how your staff use these controls.',
      ],
    },
    {
      heading: '5. What we measure for billing',
      body: [
        'We record counts of calls answered, appointments booked, and call minutes for your organization, and we use those counts to calculate what you are billed.',
        'These counts are visible to Cut Through Faster staff. Caller names, telephone numbers, transcripts and recordings are not included in what our billing view shows.',
        'You can ask us for the figures behind any invoice.',
      ],
    },
    {
      heading: '6. Acceptable use',
      body: [
        'Do not use the platform to break the law, to record or intercept calls where you are not permitted to, or to attempt to reach another organization’s data.',
        'Do not attempt to disrupt the service, circumvent its access controls, or use automated means to extract data in bulk.',
      ],
    },
    {
      heading: '7. Suspension',
      body: [
        'We may suspend an account for non-payment, for a breach of these terms, or where continuing would put other clients or callers at risk. Where circumstances allow, we will tell you first.',
        'Suspension withdraws access; it does not delete your data.',
      ],
    },
    {
      heading: '8. What we do and do not promise',
      body: [
        'We work to keep the platform available, but we do not promise uninterrupted service.',
        'The receptionist is software. It will sometimes mishear a caller, misjudge what they want, or fail to book an appointment a person would have booked. We improve it continuously and we do not promise it will be right every time.',
        'Beyond the warranties South African law requires of us, the service is provided as it stands. Keep whatever fallback you would keep for any telephone system — a diverted number, a voicemail, a person.',
      ],
    },
    {
      heading: '9. The most we can ever owe you',
      emphasis: true,
      body: [
        'This section limits what you can recover from us, and you should read it before you accept. It is one of the terms on which we are willing to provide the service at the price we charge.',
        'Our total liability to you, for everything arising out of or connected with the service, is capped at the total amount you actually paid us in the twelve months before the event giving rise to the claim. Where several claims arise, that amount is the ceiling for all of them together — not for each one.',
        'We are not liable for indirect or consequential loss of any kind. That includes lost profit, lost revenue, lost business, lost bookings, lost customers, loss of goodwill or reputation, wasted expenditure, and the cost of having the same work done elsewhere — whether or not we were told that such loss was possible. Put plainly: if a call is missed or mishandled and that customer goes elsewhere, the value of the business you lost is not something you can recover from us.',
        'None of this touches liability that cannot lawfully be limited. Our gross negligence, our wilful misconduct, our fraud, death or personal injury caused by our negligence, and the obligations we owe you as your operator under POPIA all sit outside this cap, and nothing in these terms limits them.',
      ],
    },
    {
      heading: '10. Claims that come from your callers',
      emphasis: true,
      body: [
        'You are the responsible party for the people who telephone your business, and we are your operator. That division decides who answers to whom when a call goes wrong.',
        'If a caller, a customer, or a regulator acting on their complaint brings a claim against you arising from what your receptionist said, did, failed to do, or failed to book, that claim is yours to answer. You cannot pass what you pay on it to us — not as damages, not as a contribution, and not as a claim for the amount you settled at.',
        'If such a claim is brought against us instead, you will cover us: what we are required to pay, and the reasonable legal costs of dealing with it. This covers claims arising from how your receptionist was configured, from what you instructed it to say, from your not telling callers that calls are recorded and transcribed, and from your own breach of these terms.',
        'Neither of the two paragraphs above applies where the claim arises from our gross negligence, our wilful misconduct, our fraud, or our own failure to meet our POPIA obligations as your operator. In those cases the ordinary law applies and you keep every right it gives you.',
        'If we want a claim covered we will tell you promptly, we will not settle it without asking you first, and you may take over the defence of it yourself.',
      ],
    },
    {
      heading: '11. Ending the agreement',
      body: [
        'You may stop using the platform at any time and ask us to close your account.',
        'On closure we delete or irreversibly anonymise your call data within 90 days, except where we are required to keep records for longer, and we instruct our sub-operators to do the same.',
      ],
    },
    {
      heading: '12. Changes',
      body: [
        'We may update these terms. Material changes will be shown to you when you next sign in, and continuing to use the platform means accepting the revised version.',
      ],
    },
    {
      heading: '13. Governing law',
      body: ['These terms are governed by the laws of the Republic of South Africa.'],
    },
  ],
};

export const PRIVACY: LegalDocument = {
  id: 'privacy',
  title: 'Privacy Policy',
  version: PRIVACY_VERSION,
  updated: '11 August 2026',
  intro:
    'This explains what the Cut Through Faster control platform collects, why, and who can see it. It covers two different groups of people: the staff who sign in, and the members of the public who telephone your business.',
  sections: [
    {
      heading: 'Information Officer',
      body: [
        `Our Information Officer can be reached at ${INFORMATION_OFFICER.email}. Requests to access, correct or delete personal information should be sent there, and we will respond within the periods POPIA requires.`,
        'If you are unhappy with our response you may complain to the Information Regulator of South Africa.',
      ],
    },
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
        'When someone calls your business, we store their telephone number, the name they give, a transcript of the conversation, a summary, the outcome, and where the voice provider supplies one, an audio recording.',
        'These callers are not users of this platform and have not agreed to this policy. The business they called is the responsible party for their information; Cut Through Faster is that business’s operator. Telling callers that calls are recorded and transcribed, and having a lawful basis for it, is the business’s responsibility.',
        'Cut Through Faster staff do not have a routine view of caller names, telephone numbers, transcripts or recordings.',
        `A caller who wishes to see or delete what is held about them may contact ${INFORMATION_OFFICER.email}, and we will work with the business they called to meet the request.`,
      ],
    },
    {
      heading: 'What Cut Through Faster can see',
      body: [
        'For billing we look at counts only: calls answered, appointments booked, and call minutes, per organization per month.',
        'That view does not include caller names, telephone numbers, transcripts, recordings, or the content of any conversation.',
        'If you report a fault that cannot be diagnosed from counts alone, we will ask for your permission before looking at anything more, and the access will be recorded in our audit log.',
      ],
    },
    {
      heading: 'Who else processes the information',
      body: [
        'We use the following sub-operators. Each is bound by a written agreement requiring them to protect the information to the standard POPIA requires.',
        ...SUB_PROCESSORS.map(
          (processor) =>
            `${processor.name} — ${processor.role} Located in ${processor.location}. ${
              processor.handlesCallerData
                ? 'Handles caller personal information.'
                : 'Does not handle caller personal information.'
            }`,
        ),
        'We do not sell your data or share it for advertising.',
      ],
    },
    {
      heading: 'Sending information outside South Africa',
      body: [
        'The platform’s database is hosted in Western Europe and the voice provider operates from the United States, so personal information leaves South Africa. Our hosting provider offers no African region, so this is a property of the service rather than a choice we can undo.',
        'Section 72 of POPIA permits this where the recipient is bound by an agreement that upholds principles of protection substantially similar to POPIA. We hold such agreements with each sub-operator, and the Operator Agreement passes those protections through to you.',
        'A copy of the Operator Agreement is available in the dashboard and forms part of your contract with us.',
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
        `Requests can be sent to ${INFORMATION_OFFICER.email}.`,
      ],
    },
    {
      heading: 'Security',
      body: [
        'Access to each organization is separated: every request for call data is restricted to the organization of the person making it.',
        'Sign-in sessions are held in cookies that scripts cannot read, and only a hash of each session token is stored, so the database cannot be used to impersonate anyone.',
        'Sign-in attempts and requests are rate limited.',
        `No system is perfectly secure. If a breach affects personal information we hold, we will notify the affected business and the Information Regulator as soon as reasonably possible and in any event within ${BREACH_NOTIFICATION_HOURS} hours of establishing that it has occurred, as required by section 22 of POPIA. Where the breach affects callers, we will give the business what it needs to notify them.`,
      ],
    },
  ],
};

export const OPERATOR_AGREEMENT: LegalDocument = {
  id: 'operator',
  title: 'Operator Agreement',
  version: OPERATOR_VERSION,
  updated: '11 August 2026',
  intro:
    'This agreement governs how Cut Through Faster processes personal information on your behalf. It is required by sections 20, 21 and 72 of the Protection of Personal Information Act, and it forms part of the Terms of Service. You are the responsible party; we are your operator.',
  sections: [
    {
      heading: '1. Roles',
      body: [
        'You determine why and how the personal information of your callers is processed. You are the responsible party.',
        'We process that information only on your documented instruction, in order to provide the service. We are your operator, and we do not process it for our own purposes.',
        'Using the platform as intended constitutes your instruction to us to answer your calls, transcribe them, store the records, and make them available to the staff you authorise.',
      ],
    },
    {
      heading: '2. What is processed',
      body: [
        'Categories of data subject: members of the public who telephone your business, and the staff you give logins to.',
        'Categories of personal information: telephone numbers, names given during a call, the content of the conversation as transcript and where available audio, appointment details, and for your staff, name, email address, role and mobile number.',
        'Duration: for as long as your account is open, and for up to 90 days afterwards.',
      ],
    },
    {
      heading: '3. Our obligations',
      body: [
        'We will process personal information only on your instruction, and will tell you if we believe an instruction breaches POPIA.',
        'We will secure the integrity and confidentiality of the information by taking appropriate, reasonable technical and organisational measures, as section 19 requires.',
        'We will ensure that anyone acting under our authority who has access to the information treats it as confidential.',
        `We will notify you without undue delay, and in any event within ${BREACH_NOTIFICATION_HOURS} hours of establishing that a compromise has occurred, giving you what you need to meet your own obligations under section 22.`,
        'We will assist you in responding to requests from data subjects, and in any consultation with the Information Regulator.',
        'On termination we will delete or return the information, and delete existing copies, except where the law requires us to keep it.',
      ],
    },
    {
      heading: '4. Sub-operators',
      body: [
        'You authorise us to engage the sub-operators named in our Privacy Policy, currently Cloudflare, Vapi and Google.',
        'Each is engaged under a written agreement imposing data protection obligations no less protective than those in this agreement.',
        'We remain liable to you for their performance. We will give you reasonable notice before adding or replacing a sub-operator, and you may object.',
      ],
    },
    {
      heading: '5. Transfers outside South Africa',
      body: [
        'You authorise us to transfer personal information outside the Republic, specifically to Western Europe and the United States, as described in the Privacy Policy.',
        'We rely on section 72(1)(a): each recipient is bound by an agreement that upholds principles for the lawful processing substantially similar to those in POPIA, and includes provisions substantially similar to section 72 concerning onward transfer.',
        'We will provide a copy of the relevant agreement, or a summary of its data protection provisions, on request.',
      ],
    },
    {
      heading: '6. Your obligations',
      body: [
        'You warrant that you have a lawful basis for the processing you instruct us to carry out.',
        'You are responsible for informing callers that their calls are answered by an automated system, recorded and transcribed, and for obtaining any consent the law requires.',
        'You are responsible for the accounts you create and for removing access when a staff member leaves.',
      ],
    },
    {
      heading: '7. Audit',
      body: [
        'On reasonable written notice, and no more than once a year unless a compromise has occurred, we will make available the information necessary to demonstrate our compliance with this agreement.',
      ],
    },
    {
      heading: '8. Precedence',
      body: [
        'Where this agreement conflicts with the Terms of Service on the processing of personal information, this agreement prevails.',
        'This agreement is governed by the laws of the Republic of South Africa.',
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, LegalDocument> = {
  terms: TERMS,
  privacy: PRIVACY,
  operator: OPERATOR_AGREEMENT,
};

export const CURRENT_VERSIONS: Record<LegalDocumentId, string> = {
  terms: TERMS_VERSION,
  privacy: PRIVACY_VERSION,
  operator: OPERATOR_VERSION,
};
