// What the OpenAI Realtime voice needs (core/plugins.mjs reads this): its settings. Without the
// API key the voice is off and Lookma takes typed requests. Dependency-free, like every manifest.
export default {
  title: 'OpenAI Realtime',
  settings: {
    apiKey: { default: '', env: 'OPENAI_API_KEY', secret: true, required: true, help: 'turns on voice; without it you type instead' },
    model: { default: 'gpt-realtime-2.1', help: 'the voice model' },
    voice: { default: 'marin', help: 'the voice it speaks with' },
    transcribeModel: { default: 'gpt-realtime-whisper', help: 'writes down what you say, for captions and the approval check' },
    maxTokens: { default: 1000, help: 'a safety net on one reply, in tokens, its audio included; the prompt keeps replies short' },
  },
}
