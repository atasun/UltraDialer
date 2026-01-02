'use strict';
import WebSocket, { WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { storage } from '../../storage';
import { OpenAIPoolService } from '../../engines/plivo/services/openai-pool.service';

interface DemoSession {
  sessionId: string;
  sessionToken: string;
  browserWs: WebSocket;
  openaiWs: WebSocket | null;
  systemPrompt: string;
  voice: string;
  language: string;
  maxDuration: number;
  startTime: number;
  transcript: string[];
  credentialId: string | null;
  timeoutHandle: NodeJS.Timeout | null;
}

const activeSessions = new Map<string, DemoSession>();

export function setupDemoCallWebSocket(wss: WebSocketServer) {
  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const sessionToken = url.searchParams.get('token');
    
    if (!sessionToken) {
      ws.close(4001, 'Missing session token');
      return;
    }

    const dbSession = await storage.getDemoSessionByToken(sessionToken);
    if (!dbSession) {
      ws.close(4002, 'Invalid session token');
      return;
    }

    if (dbSession.status !== 'pending' && dbSession.status !== 'active') {
      ws.close(4003, 'Session expired or completed');
      return;
    }

    const credential = await OpenAIPoolService.getAvailableCredential();
    if (!credential) {
      ws.close(4004, 'No OpenAI credentials available');
      return;
    }

    const promptSetting = await storage.getGlobalSetting('demo_system_prompt');
    const systemPrompt = (promptSetting?.value as string) || 
      'You are a friendly AI assistant demonstrating voice conversation capabilities. Be helpful and engaging. Keep responses concise.';

    const kbIdsSetting = await storage.getGlobalSetting('demo_knowledge_base_ids');
    const knowledgeBaseIds = (kbIdsSetting?.value as string[]) || [];

    let fullPrompt = systemPrompt;
    if (knowledgeBaseIds.length > 0) {
      const kbItems = await Promise.all(
        knowledgeBaseIds.map(id => storage.getKnowledgeBaseItem(id))
      );
      const kbContent = kbItems.filter(Boolean).map(kb => kb!.content).join('\n\n');
      if (kbContent) {
        fullPrompt += `\n\n--- Knowledge Base ---\n${kbContent}`;
      }
    }

    if (dbSession.language !== 'en') {
      fullPrompt += `\n\nIMPORTANT: Respond in the user's preferred language: ${dbSession.language}`;
    }

    const session: DemoSession = {
      sessionId: dbSession.id,
      sessionToken,
      browserWs: ws,
      openaiWs: null,
      systemPrompt: fullPrompt,
      voice: dbSession.voice,
      language: dbSession.language,
      maxDuration: dbSession.maxDuration || 60,
      startTime: Date.now(),
      transcript: [],
      credentialId: credential.id,
      timeoutHandle: null,
    };

    activeSessions.set(sessionToken, session);

    await storage.updateDemoSession(dbSession.id, {
      status: 'active',
      startedAt: new Date(),
      openaiCredentialId: credential.id,
    });

    session.timeoutHandle = setTimeout(() => {
      endSession(sessionToken, 'timeout');
    }, session.maxDuration * 1000);

    try {
      const openaiWs = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
        {
          headers: {
            'Authorization': `Bearer ${credential.apiKey}`,
            'OpenAI-Beta': 'realtime=v1',
          },
        }
      );

      session.openaiWs = openaiWs;

      openaiWs.on('open', () => {
        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: session.systemPrompt,
            voice: session.voice,
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: {
              model: 'whisper-1',
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
        }));

        ws.send(JSON.stringify({ type: 'session.ready' }));
      });

      openaiWs.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          if (message.type === 'response.audio.delta' && message.delta) {
            ws.send(JSON.stringify({
              type: 'audio',
              data: message.delta,
            }));
          }
          
          if (message.type === 'response.audio_transcript.delta') {
            session.transcript.push(`Assistant: ${message.delta}`);
          }
          
          if (message.type === 'conversation.item.input_audio_transcription.completed') {
            session.transcript.push(`User: ${message.transcript}`);
          }
          
          if (message.type === 'error') {
            console.error('OpenAI error:', message.error);
            ws.send(JSON.stringify({ type: 'error', message: message.error?.message || 'OpenAI error' }));
          }
        } catch (e) {
          console.error('Error processing OpenAI message:', e);
        }
      });

      openaiWs.on('close', () => {
        endSession(sessionToken, 'openai_closed');
      });

      openaiWs.on('error', (error) => {
        console.error('OpenAI WebSocket error:', error);
        endSession(sessionToken, 'openai_error');
      });

    } catch (error) {
      console.error('Failed to connect to OpenAI:', error);
      ws.close(4005, 'Failed to connect to AI service');
      activeSessions.delete(sessionToken);
      return;
    }

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'audio' && session.openaiWs?.readyState === WebSocket.OPEN) {
          session.openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: message.data,
          }));
        }
        
        if (message.type === 'end') {
          endSession(sessionToken, 'user_ended');
        }
      } catch (e) {
        console.error('Error processing browser message:', e);
      }
    });

    ws.on('close', () => {
      endSession(sessionToken, 'browser_closed');
    });

    ws.on('error', (error) => {
      console.error('Browser WebSocket error:', error);
      endSession(sessionToken, 'browser_error');
    });
  });
}

async function endSession(sessionToken: string, reason: string) {
  const session = activeSessions.get(sessionToken);
  if (!session) return;

  if (session.timeoutHandle) {
    clearTimeout(session.timeoutHandle);
  }

  const duration = Math.round((Date.now() - session.startTime) / 1000);

  try {
    await storage.updateDemoSession(session.sessionId, {
      status: 'completed',
      duration,
      transcript: session.transcript.join('\n'),
      endedAt: new Date(),
    });
  } catch (e) {
    console.error('Failed to update demo session:', e);
  }

  if (session.openaiWs?.readyState === WebSocket.OPEN) {
    session.openaiWs.close();
  }

  if (session.browserWs.readyState === WebSocket.OPEN) {
    session.browserWs.send(JSON.stringify({ 
      type: 'session.ended', 
      reason,
      duration 
    }));
    session.browserWs.close();
  }

  activeSessions.delete(sessionToken);
  console.log(`Demo session ended: ${session.sessionId} (${reason}, ${duration}s)`);
}

export function getActiveDemoSessionCount(): number {
  return activeSessions.size;
}
