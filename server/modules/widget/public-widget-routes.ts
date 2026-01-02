import { Router, Request, Response, NextFunction } from "express";
import { widgetService } from "./widget-service";
import { widgetStorage } from "./widget-storage";
import { nanoid } from "nanoid";
import { db } from "../../db";
import { creditTransactions, users, calls, agents } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { OpenAIPoolService } from "../../engines/plivo/services/openai-pool.service";

const router = Router();

// CORS middleware for public widget endpoints - allows embedding on external websites
router.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

router.get('/widget/config/:token', async (req: Request, res: Response) => {
  try {
    const widget = await widgetService.getWidgetByToken(req.params.token);
    
    if (!widget) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    
    if (widget.status !== 'active') {
      return res.status(403).json({ error: 'Widget is not active', status: widget.status });
    }
    
    const origin = req.headers.origin || req.headers.referer || '';
    let domain = '';
    try {
      const url = new URL(origin);
      domain = url.hostname;
    } catch {
      domain = origin.replace(/^https?:\/\//, '').split('/')[0];
    }
    
    if (domain && !widgetService.validateDomain(widget, domain)) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }
    
    const businessHours = widgetService.checkBusinessHours(widget);
    const creditCheck = await widgetService.checkUserCredits(widget.userId, 1);
    const concurrentCheck = await widgetService.checkConcurrentCallLimit(widget.id);
    
    const isAvailable = widget.status === 'active' && 
                        businessHours.isOpen && 
                        creditCheck.hasCredits && 
                        concurrentCheck.allowed;
    
    res.json({
      name: widget.brandName || widget.name,
      brandName: widget.brandName,
      buttonLabel: widget.buttonLabel,
      iconUrl: widget.iconUrl,
      iconPath: (widget as any).iconPath,
      primaryColor: widget.primaryColor,
      accentColor: widget.accentColor,
      backgroundColor: widget.backgroundColor,
      textColor: widget.textColor,
      welcomeMessage: widget.welcomeMessage,
      launcherText: widget.launcherText,
      offlineMessage: widget.offlineMessage,
      lowCreditsMessage: widget.lowCreditsMessage,
      maxCallDuration: widget.maxCallDuration,
      requireTermsAcceptance: widget.requireTermsAcceptance,
      isAvailable,
      unavailableReason: !businessHours.isOpen ? 'outside_hours' : 
                         !creditCheck.hasCredits ? 'no_credits' :
                         !concurrentCheck.allowed ? 'busy' : null,
    });
  } catch (error) {
    console.error('Error fetching widget config:', error);
    res.status(500).json({ error: 'Failed to fetch widget config' });
  }
});

router.post('/widget/session/start', async (req: Request, res: Response) => {
  try {
    const { embedToken, visitorDomain } = req.body;
    
    if (!embedToken) {
      return res.status(400).json({ error: 'Embed token required' });
    }
    
    const widget = await widgetService.getWidgetByToken(embedToken);
    if (!widget) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    
    if (widget.status !== 'active') {
      return res.status(403).json({ error: 'Widget is not active' });
    }
    
    if (visitorDomain && !widgetService.validateDomain(widget, visitorDomain)) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }
    
    const businessHours = widgetService.checkBusinessHours(widget);
    if (!businessHours.isOpen) {
      return res.status(403).json({ error: 'Outside business hours', message: widget.offlineMessage });
    }
    
    const creditCheck = await widgetService.checkUserCredits(widget.userId, 1);
    if (!creditCheck.hasCredits) {
      return res.status(403).json({ error: 'Insufficient credits', message: widget.lowCreditsMessage });
    }
    
    const concurrentCheck = await widgetService.checkConcurrentCallLimit(widget.id);
    if (!concurrentCheck.allowed) {
      return res.status(429).json({ error: 'Too many concurrent calls', message: 'Please try again in a moment' });
    }
    
    const sessionToken = `ws_${nanoid(32)}`;
    const visitorIp = req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '';
    
    const session = await widgetStorage.createSession({
      widgetId: widget.id,
      userId: widget.userId,
      sessionToken,
      visitorIp: typeof visitorIp === 'string' ? visitorIp.split(',')[0].trim() : '',
      visitorDomain: visitorDomain || null,
      status: 'pending',
    });
    
    res.json({
      sessionId: session.id,
      sessionToken,
      maxDuration: widget.maxCallDuration,
    });
  } catch (error) {
    console.error('Error starting widget session:', error);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

router.post('/widget/session/:sessionId/connect', async (req: Request, res: Response) => {
  try {
    const { sessionToken } = req.body;
    const session = await widgetStorage.getSessionById(req.params.sessionId);
    
    if (!session || session.sessionToken !== sessionToken) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    if (session.status !== 'pending') {
      return res.status(400).json({ error: 'Session already started' });
    }
    
    await widgetStorage.updateSession(session.id, {
      status: 'connecting',
      startedAt: new Date(),
    });
    
    const widget = await widgetStorage.getWidgetById(session.widgetId);
    if (!widget) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    
    res.json({
      success: true,
      widgetId: widget.id,
      agentId: widget.agentId,
      agentType: widget.agentType,
    });
  } catch (error) {
    console.error('Error connecting session:', error);
    res.status(500).json({ error: 'Failed to connect session' });
  }
});

router.post('/widget/session/:sessionId/end', async (req: Request, res: Response) => {
  try {
    const { sessionToken, duration, transcript, sentiment } = req.body;
    const session = await widgetStorage.getSessionById(req.params.sessionId);
    
    if (!session || session.sessionToken !== sessionToken) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const durationSeconds = duration || 0;
    const durationMinutes = Math.ceil(durationSeconds / 60);
    const creditsUsed = durationMinutes;
    
    await widgetStorage.updateSession(session.id, {
      status: 'completed',
      duration: durationSeconds,
      creditsUsed,
      transcript: transcript || null,
      sentiment: sentiment || null,
      endedAt: new Date(),
    });
    
    const widget = await widgetStorage.getWidgetById(session.widgetId);
    if (widget && creditsUsed > 0) {
      await db.update(users)
        .set({ credits: sql`GREATEST(${users.credits} - ${creditsUsed}, 0)` })
        .where(eq(users.id, session.userId));
      
      await db.insert(creditTransactions).values({
        userId: session.userId,
        type: 'widget_call',
        amount: -creditsUsed,
        description: `Widget call: ${widget.name}`,
        reference: session.id,
        widgetId: widget.id,
      });
      
      await db.insert(calls).values({
        userId: session.userId,
        widgetId: widget.id,
        status: 'completed',
        callDirection: 'incoming',
        duration: durationSeconds,
        transcript: transcript || null,
        sentiment: sentiment || null,
        startedAt: session.startedAt,
        endedAt: new Date(),
      });
      
      await widgetStorage.incrementWidgetStats(widget.id, durationMinutes);
    }
    
    res.json({ success: true, creditsUsed });
  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

router.post('/widget/session/:sessionId/heartbeat', async (req: Request, res: Response) => {
  try {
    const { sessionToken } = req.body;
    const session = await widgetStorage.getSessionById(req.params.sessionId);
    
    if (!session || session.sessionToken !== sessionToken) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    if (session.status === 'pending') {
      await widgetStorage.updateSession(session.id, { status: 'active' });
    }
    
    const widget = await widgetStorage.getWidgetById(session.widgetId);
    if (!widget) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    
    const creditCheck = await widgetService.checkUserCredits(widget.userId, 1);
    
    res.json({
      continue: creditCheck.hasCredits,
      remainingCredits: creditCheck.credits,
    });
  } catch (error) {
    console.error('Error processing heartbeat:', error);
    res.status(500).json({ error: 'Failed to process heartbeat' });
  }
});

router.post('/widget/session/:sessionId/ephemeral-token', async (req: Request, res: Response) => {
  try {
    const { sessionToken } = req.body;
    const session = await widgetStorage.getSessionById(req.params.sessionId);
    
    if (!session || session.sessionToken !== sessionToken) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    if (session.status !== 'pending' && session.status !== 'active' && session.status !== 'connecting') {
      return res.status(400).json({ error: 'Session expired or completed' });
    }
    
    const widget = await widgetStorage.getWidgetById(session.widgetId);
    if (!widget) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    
    const credential = await OpenAIPoolService.getAvailableCredential();
    if (!credential) {
      return res.status(503).json({ error: 'AI service unavailable. Please try again later.' });
    }
    
    let systemPrompt = widget.welcomeMessage || 'Hello! How can I help you today?';
    let voice = 'alloy';
    
    if (widget.agentId) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, widget.agentId));
      if (agent) {
        systemPrompt = agent.systemPrompt || systemPrompt;
        voice = agent.openaiVoice || voice;
      }
    }
    
    const ephemeralResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credential.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice,
        instructions: systemPrompt,
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
      console.error('[Widget] OpenAI Realtime API Error:', {
        status: ephemeralResponse.status,
        statusText: ephemeralResponse.statusText,
        body: errorData,
        credentialId: credential.id,
        model: 'gpt-4o-realtime-preview-2024-12-17'
      });
      
      // Parse error for user-friendly message
      let userMessage = 'Failed to initialize AI session';
      try {
        const parsed = JSON.parse(errorData);
        if (parsed.error?.message) {
          if (parsed.error.message.includes('does not exist') || parsed.error.message.includes('not found')) {
            userMessage = 'OpenAI Realtime API access not available. Please check your API key permissions.';
          } else if (parsed.error.message.includes('quota') || parsed.error.message.includes('rate')) {
            userMessage = 'AI service is temporarily busy. Please try again in a moment.';
          } else if (parsed.error.message.includes('invalid') || parsed.error.message.includes('unauthorized')) {
            userMessage = 'AI service authentication failed. Please contact support.';
          }
        }
      } catch (e) {}
      
      return res.status(500).json({ error: userMessage });
    }
    
    const tokenData = await ephemeralResponse.json();
    
    await widgetStorage.updateSession(session.id, {
      status: 'active',
      startedAt: new Date(),
    });
    
    res.json({
      client_secret: tokenData.client_secret,
      maxDuration: widget.maxCallDuration,
    });
  } catch (error) {
    console.error('Error getting ephemeral token:', error);
    res.status(500).json({ error: 'Failed to get ephemeral token' });
  }
});

export default router;
