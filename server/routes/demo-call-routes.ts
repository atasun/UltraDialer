'use strict';
import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import { nanoid } from 'nanoid';
import { OpenAIPoolService } from '../engines/plivo/services/openai-pool.service';

const router = Router();

const OPENAI_VOICES = [
  { id: 'alloy', name: 'Alloy', description: 'Neutral, versatile voice', gender: 'neutral' },
  { id: 'echo', name: 'Echo', description: 'Warm, engaging voice', gender: 'male' },
  { id: 'shimmer', name: 'Shimmer', description: 'Expressive, dynamic voice', gender: 'female' },
  { id: 'ash', name: 'Ash', description: 'Calm, measured voice', gender: 'male' },
  { id: 'ballad', name: 'Ballad', description: 'Warm, melodic voice', gender: 'female' },
  { id: 'coral', name: 'Coral', description: 'Clear, friendly voice', gender: 'female' },
  { id: 'sage', name: 'Sage', description: 'Thoughtful, wise voice', gender: 'neutral' },
  { id: 'verse', name: 'Verse', description: 'Poetic, expressive voice', gender: 'male' },
];

const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'zh', name: 'Chinese', nativeName: '中文' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
  { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română' },
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български' },
  { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'fil', name: 'Filipino', nativeName: 'Filipino' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
  { code: 'mr', name: 'Marathi', nativeName: 'मराठी' },
  { code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી' },
  { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ' },
  { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം' },
  { code: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو' },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی' },
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili' },
  { code: 'af', name: 'Afrikaans', nativeName: 'Afrikaans' },
  { code: 'ca', name: 'Catalan', nativeName: 'Català' },
  { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių' },
  { code: 'lv', name: 'Latvian', nativeName: 'Latviešu' },
  { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina' },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti' },
];

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

router.get('/api/public/demo-config', async (_req: Request, res: Response) => {
  try {
    const [enabledSetting, maxDurationSetting, appNameSetting] = await Promise.all([
      storage.getGlobalSetting('demo_widget_enabled'),
      storage.getGlobalSetting('demo_max_duration'),
      storage.getGlobalSetting('app_name'),
    ]);

    const enabled = enabledSetting?.value === true || enabledSetting?.value === 'true';
    const maxDuration = (maxDurationSetting?.value as number) || 60;
    const appName = (appNameSetting?.value as string) || 'AgentLabs';

    res.json({
      enabled,
      maxDuration,
      appName,
      languages: SUPPORTED_LANGUAGES,
      voices: OPENAI_VOICES,
    });
  } catch (error) {
    console.error('Error fetching demo config:', error);
    res.status(500).json({ error: 'Failed to fetch demo configuration' });
  }
});

router.get('/api/public/demo-voices', async (_req: Request, res: Response) => {
  try {
    res.json({
      languages: SUPPORTED_LANGUAGES,
      voices: OPENAI_VOICES,
    });
  } catch (error) {
    console.error('Error fetching demo voices:', error);
    res.status(500).json({ error: 'Failed to fetch voices' });
  }
});

router.post('/api/public/demo-session', async (req: Request, res: Response) => {
  try {
    const { language = 'en', voice = 'alloy' } = req.body;

    const enabledSetting = await storage.getGlobalSetting('demo_widget_enabled');
    const enabled = enabledSetting?.value === true || enabledSetting?.value === 'true';
    
    if (!enabled) {
      return res.status(403).json({ error: 'Demo calls are currently disabled' });
    }

    const clientIp = getClientIp(req);
    
    const cooldownSetting = await storage.getGlobalSetting('demo_cooldown_minutes');
    const cooldownMinutes = (cooldownSetting?.value as number) || 5;
    
    const recentSession = await storage.getRecentDemoSessionByIp(clientIp, cooldownMinutes);
    if (recentSession) {
      const waitTime = Math.ceil(cooldownMinutes - (Date.now() - new Date(recentSession.createdAt).getTime()) / 60000);
      return res.status(429).json({ 
        error: `Please wait ${waitTime} minute(s) before starting another demo call`,
        retryAfter: waitTime * 60 
      });
    }

    const maxConcurrentSetting = await storage.getGlobalSetting('demo_max_concurrent');
    const maxConcurrent = (maxConcurrentSetting?.value as number) || 10;
    
    const activeCount = await storage.getActiveDemoSessionCount();
    if (activeCount >= maxConcurrent) {
      return res.status(503).json({ error: 'Demo service is busy. Please try again in a moment.' });
    }

    const maxDurationSetting = await storage.getGlobalSetting('demo_max_duration');
    const maxDuration = (maxDurationSetting?.value as number) || 60;

    const sessionToken = nanoid(32);
    
    const session = await storage.createDemoSession({
      sessionToken,
      visitorIp: clientIp,
      language,
      voice,
      status: 'pending',
      maxDuration,
    });

    res.json({
      sessionId: session.id,
      sessionToken,
      maxDuration,
      language,
      voice,
    });
  } catch (error) {
    console.error('Error creating demo session:', error);
    res.status(500).json({ error: 'Failed to create demo session' });
  }
});

router.post('/api/public/demo-session/:sessionId/start', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { sessionToken } = req.body;

    const session = await storage.getDemoSession(sessionId);
    if (!session || session.sessionToken !== sessionToken) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'pending') {
      return res.status(400).json({ error: 'Session already started or completed' });
    }

    await storage.updateDemoSession(sessionId, {
      status: 'active',
      startedAt: new Date(),
    });

    const promptSetting = await storage.getGlobalSetting('demo_system_prompt');
    const systemPrompt = (promptSetting?.value as string) || 
      `You are a friendly AI assistant demonstrating voice conversation capabilities. 
Be helpful, engaging, and showcase natural conversation flow. 
Keep responses concise (1-2 sentences) for smooth dialogue.
If asked about the product or service, explain you're a demo of an AI voice agent platform.`;

    const kbIdsSetting = await storage.getGlobalSetting('demo_knowledge_base_ids');
    const knowledgeBaseIds = (kbIdsSetting?.value as string[]) || [];

    let knowledgeContext = '';
    if (knowledgeBaseIds.length > 0) {
      const kbItems = await Promise.all(
        knowledgeBaseIds.map(id => storage.getKnowledgeBaseItem(id))
      );
      const validKbs = kbItems.filter(kb => kb !== undefined);
      if (validKbs.length > 0) {
        knowledgeContext = validKbs.map(kb => kb!.content).join('\n\n');
      }
    }

    const languageInstruction = session.language !== 'en' 
      ? `\n\nIMPORTANT: Respond in ${SUPPORTED_LANGUAGES.find(l => l.code === session.language)?.name || session.language}. The user prefers this language.`
      : '';

    const fullPrompt = knowledgeContext 
      ? `${systemPrompt}\n\n--- Knowledge Base ---\n${knowledgeContext}${languageInstruction}`
      : `${systemPrompt}${languageInstruction}`;

    res.json({
      sessionId: session.id,
      systemPrompt: fullPrompt,
      voice: session.voice,
      language: session.language,
      maxDuration: session.maxDuration,
    });
  } catch (error) {
    console.error('Error starting demo session:', error);
    res.status(500).json({ error: 'Failed to start demo session' });
  }
});

router.post('/api/public/demo-session/:sessionId/end', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { sessionToken, duration, transcript } = req.body;

    const session = await storage.getDemoSession(sessionId);
    if (!session || session.sessionToken !== sessionToken) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await storage.updateDemoSession(sessionId, {
      status: 'completed',
      duration: duration || 0,
      transcript: transcript || null,
      endedAt: new Date(),
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error ending demo session:', error);
    res.status(500).json({ error: 'Failed to end demo session' });
  }
});

router.post('/api/public/demo-ephemeral-token', async (req: Request, res: Response) => {
  try {
    const { sessionId, sessionToken } = req.body;

    if (!sessionId || !sessionToken) {
      return res.status(400).json({ error: 'Missing session credentials' });
    }

    const session = await storage.getDemoSession(sessionId);
    if (!session || session.sessionToken !== sessionToken) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'pending' && session.status !== 'active') {
      return res.status(400).json({ error: 'Session expired or completed' });
    }

    const credential = await OpenAIPoolService.getAvailableCredential();
    if (!credential) {
      return res.status(503).json({ error: 'No AI service available. Please try again later.' });
    }

    const promptSetting = await storage.getGlobalSetting('demo_system_prompt');
    const systemPrompt = (promptSetting?.value as string) || 
      `You are a friendly AI assistant demonstrating voice conversation capabilities. 
Be helpful, engaging, and showcase natural conversation flow. 
Keep responses concise (1-2 sentences) for smooth dialogue.
If asked about the product or service, explain you're a demo of an AI voice agent platform.`;

    const kbIdsSetting = await storage.getGlobalSetting('demo_knowledge_base_ids');
    const knowledgeBaseIds = (kbIdsSetting?.value as string[]) || [];

    let knowledgeContext = '';
    if (knowledgeBaseIds.length > 0) {
      const kbItems = await Promise.all(
        knowledgeBaseIds.map(id => storage.getKnowledgeBaseItem(id))
      );
      const validKbs = kbItems.filter(kb => kb !== undefined);
      if (validKbs.length > 0) {
        knowledgeContext = validKbs.map(kb => kb!.content).join('\n\n');
      }
    }

    const languageInstruction = session.language !== 'en' 
      ? `\n\nIMPORTANT: Respond in ${SUPPORTED_LANGUAGES.find(l => l.code === session.language)?.name || session.language}. The user prefers this language.`
      : '';

    const fullPrompt = knowledgeContext 
      ? `${systemPrompt}\n\n--- Knowledge Base ---\n${knowledgeContext}${languageInstruction}`
      : `${systemPrompt}${languageInstruction}`;

    const ephemeralResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credential.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: session.voice || 'alloy',
        instructions: fullPrompt,
        input_audio_transcription: {
          model: 'whisper-1',
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      }),
    });

    if (!ephemeralResponse.ok) {
      const errorData = await ephemeralResponse.text();
      console.error('OpenAI ephemeral token error:', errorData);
      return res.status(500).json({ error: 'Failed to initialize AI session' });
    }

    const tokenData = await ephemeralResponse.json();

    await storage.updateDemoSession(sessionId, {
      status: 'active',
      startedAt: new Date(),
      openaiCredentialId: credential.id,
    });

    res.json({
      client_secret: tokenData.client_secret,
      voice: session.voice,
      instructions: fullPrompt,
      maxDuration: session.maxDuration,
    });
  } catch (error) {
    console.error('Error generating ephemeral token:', error);
    res.status(500).json({ error: 'Failed to initialize demo session' });
  }
});

router.get('/api/admin/demo-stats', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const stats = await storage.getDemoSessionStats(days);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching demo stats:', error);
    res.status(500).json({ error: 'Failed to fetch demo statistics' });
  }
});

export default router;
