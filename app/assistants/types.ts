// The shape of a Vapi assistant, as much of it as CTF actually sets.
//
// Deliberately not exhaustive. Vapi's assistant object has dozens of fields;
// typing all of them would be a second, worse copy of their API reference that
// goes stale. These are the ones this repo writes, so a typo in them fails the
// build instead of failing on a live call.

export interface VapiStructuredProperty {
  type: 'string' | 'number' | 'boolean';
  description: string;
  enum?: string[];
}

export interface VapiAssistantConfig {
  name: string;
  firstMessage: string;
  voicemailMessage?: string;
  endCallMessage?: string;

  model: {
    provider: string;
    model: string;
    temperature?: number;
    messages: { role: 'system'; content: string }[];
  };

  voice: {
    provider: string;
    voiceId: string;
    speed?: number;
  };

  transcriber?: {
    provider: string;
    model: string;
    language: string;
  };

  silenceTimeoutSeconds?: number;
  maxDurationSeconds?: number;
  startSpeakingPlan?: { waitSeconds: number };
  stopSpeakingPlan?: { numWords: number };

  analysisPlan: {
    summaryPrompt: string;
    structuredDataPlan: {
      enabled: boolean;
      schema: {
        type: 'object';
        properties: Record<string, VapiStructuredProperty>;
      };
    };
  };

  serverMessages: string[];
}
