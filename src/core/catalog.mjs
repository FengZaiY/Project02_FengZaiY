export const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', protocol: 'openai', endpoint: 'https://api.openai.com/v1' },
  { id: 'google', name: 'Google Gemini', protocol: 'gemini', endpoint: 'https://generativelanguage.googleapis.com' },
  { id: 'grok', name: 'Grok', protocol: 'openai', endpoint: 'https://api.x.ai/v1' },
  { id: 'volcengine', name: '火山方舟 · 豆包', protocol: 'openai', endpoint: 'https://ark.cn-beijing.volces.com/api/v3' },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', endpoint: 'https://api.deepseek.com' },
  { id: 'zhipu', name: '智谱 GLM', protocol: 'openai', endpoint: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'moonshot', name: 'Kimi', protocol: 'openai', endpoint: 'https://api.moonshot.cn/v1' },
  { id: 'minimax', name: 'MiniMax', protocol: 'openai', endpoint: 'https://api.minimaxi.com/v1' },
  { id: 'siliconflow', name: '硅基流动', protocol: 'openai', endpoint: 'https://api.siliconflow.cn/v1' },
  { id: 'ollama', name: 'Ollama · 本地', protocol: 'ollama', endpoint: 'http://127.0.0.1:11434' }
];
export const LOCAL_FAMILIES = ['Qwen', 'DeepSeek', 'GLM', 'MiniMax', 'Gemma', 'Llama'];
export const TYPES = ['note', 'draft', 'conversation', 'source', 'annotation', 'relation', 'proposal', 'workspace', 'asset', 'provider', 'model', 'usage', 'task'];
