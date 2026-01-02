'use strict';
/**
 * ============================================================
 * Plivo-ElevenLabs SIP Trunk - Webhook Routes
 * 
 * Handles Plivo SIP trunk webhooks for ElevenLabs integration.
 * ISOLATED from Twilio+ElevenLabs and Plivo+OpenAI systems.
 * ============================================================
 */

import type { Express, Request, Response } from 'express';
import { getSipStreamUrl } from '../config/config';
import { ElevenLabsBridgeService } from '../services/elevenlabs-bridge.service';
import { db } from '../../../db';
import { agents, plivoPhoneNumbers, users, flowExecutions, plivoCalls } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../../../utils/logger';

export function setupPlivoElevenLabsWebhooks(app: Express, baseUrl: string): void {
  
  /**
   * Answer URL for SIP trunk calls
   * Returns XML with Stream instruction to connect to our WebSocket
   */
  app.post('/api/plivo-elevenlabs/voice/answer', async (req: Request, res: Response) => {
    try {
      const { CallUUID, From, To, Direction } = req.body;
      
      logger.info(`Answer: ${CallUUID} from ${From} to ${To} (${Direction})`, undefined, 'PlivoElevenLabs');
      
      const streamUrl = getSipStreamUrl(CallUUID);
      
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    ${streamUrl}
  </Stream>
</Response>`;
      
      res.set('Content-Type', 'text/xml');
      res.send(xml);
    } catch (error: any) {
      logger.error('Answer error', error, 'PlivoElevenLabs');
      res.set('Content-Type', 'text/xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    }
  });
  
  /**
   * Answer URL with call ID path (for outbound calls)
   */
  app.post('/api/plivo-elevenlabs/voice/:callId', async (req: Request, res: Response) => {
    try {
      const { callId } = req.params;
      const { CallUUID, From, To, Direction } = req.body;
      
      logger.info(`Answer for ${callId}: ${CallUUID} from ${From} to ${To} (${Direction})`, undefined, 'PlivoElevenLabs');
      
      const streamUrl = getSipStreamUrl(CallUUID);
      
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    ${streamUrl}
  </Stream>
</Response>`;
      
      res.set('Content-Type', 'text/xml');
      res.send(xml);
    } catch (error: any) {
      logger.error('Answer error', error, 'PlivoElevenLabs');
      res.set('Content-Type', 'text/xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    }
  });
  
  /**
   * Status callback
   */
  app.post('/api/plivo-elevenlabs/voice/status', async (req: Request, res: Response) => {
    try {
      const { CallUUID, CallStatus, Duration, HangupCause } = req.body;
      
      logger.info(`Status: ${CallUUID} -> ${CallStatus} (duration: ${Duration}s, cause: ${HangupCause})`, undefined, 'PlivoElevenLabs');
      
      if (CallStatus === 'completed' || CallStatus === 'failed' || CallStatus === 'busy' || CallStatus === 'no-answer') {
        const result = await ElevenLabsBridgeService.endSession(CallUUID);
        logger.info(`Session ended: duration=${result.duration}s, transcript parts=${result.transcript.length}`, undefined, 'PlivoElevenLabs');
        
        // Update flow execution status - find the call by Plivo UUID first
        try {
          const [call] = await db
            .select()
            .from(plivoCalls)
            .where(eq(plivoCalls.plivoCallUuid, CallUUID))
            .limit(1);
          
          if (call) {
            const [flowExec] = await db
              .select()
              .from(flowExecutions)
              .where(eq(flowExecutions.callId, call.id))
              .limit(1);
            
            if (flowExec && (flowExec.status === 'running' || flowExec.status === 'pending')) {
              const execStatus = CallStatus === 'completed' ? 'completed' : 'failed';
              await db
                .update(flowExecutions)
                .set({
                  status: execStatus,
                  completedAt: new Date(),
                  error: CallStatus !== 'completed' ? `Call ended with status: ${CallStatus}` : null,
                })
                .where(eq(flowExecutions.id, flowExec.id));
              logger.info(`Updated flow execution ${flowExec.id} to ${execStatus}`, undefined, 'PlivoElevenLabs');
            }
          }
        } catch (flowExecError: any) {
          logger.warn(`Failed to update flow execution status: ${flowExecError.message}`, undefined, 'PlivoElevenLabs');
        }
      }
      
      res.sendStatus(200);
    } catch (error: any) {
      logger.error('Status error', error, 'PlivoElevenLabs');
      res.sendStatus(200);
    }
  });
  
  /**
   * Incoming call handler for SIP trunk
   */
  app.post('/api/plivo-elevenlabs/incoming', async (req: Request, res: Response) => {
    try {
      const { CallUUID, From, To, Direction } = req.body;
      
      logger.info(`Incoming SIP call: ${CallUUID} from ${From} to ${To}`, undefined, 'PlivoElevenLabs');
      
      const [phoneNumber] = await db
        .select()
        .from(plivoPhoneNumbers)
        .where(eq(plivoPhoneNumbers.phoneNumber, To))
        .limit(1);
      
      if (!phoneNumber || !phoneNumber.assignedAgentId) {
        logger.error(`Phone not configured: ${To}`, undefined, 'PlivoElevenLabs');
        res.set('Content-Type', 'text/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Sorry, this number is not configured. Goodbye.</Speak>
  <Hangup/>
</Response>`);
        return;
      }
      
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, phoneNumber.assignedAgentId))
        .limit(1);
      
      if (!agent || !agent.elevenLabsAgentId) {
        logger.error(`Agent not found or no ElevenLabs ID: ${phoneNumber.assignedAgentId}`, undefined, 'PlivoElevenLabs');
        res.set('Content-Type', 'text/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Sorry, the agent is not available. Goodbye.</Speak>
  <Hangup/>
</Response>`);
        return;
      }
      
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, agent.userId))
        .limit(1);
      
      if (!user || user.credits < 1) {
        logger.error('Insufficient credits', undefined, 'PlivoElevenLabs');
        res.set('Content-Type', 'text/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Service temporarily unavailable. Goodbye.</Speak>
  <Hangup/>
</Response>`);
        return;
      }
      
      const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
      if (!elevenLabsApiKey) {
        logger.error('ElevenLabs API key not configured', undefined, 'PlivoElevenLabs');
        res.set('Content-Type', 'text/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Service configuration error. Goodbye.</Speak>
  <Hangup/>
</Response>`);
        return;
      }
      
      await ElevenLabsBridgeService.createSession({
        callUuid: CallUUID,
        agentId: agent.elevenLabsAgentId,
        elevenLabsApiKey,
        agentConfig: {
          agentId: agent.elevenLabsAgentId,
          firstMessage: agent.firstMessage || undefined,
          language: agent.language || 'en',
        },
        fromNumber: From,
        toNumber: To,
        direction: 'inbound',
      });
      
      const streamUrl = getSipStreamUrl(CallUUID);
      
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    ${streamUrl}
  </Stream>
</Response>`;
      
      res.set('Content-Type', 'text/xml');
      res.send(xml);
    } catch (error: any) {
      logger.error('Incoming call error', error, 'PlivoElevenLabs');
      res.set('Content-Type', 'text/xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>An error occurred. Goodbye.</Speak>
  <Hangup/>
</Response>`);
    }
  });
  
  logger.info('Plivo-ElevenLabs SIP trunk webhook routes registered', undefined, 'PlivoElevenLabs');
}
