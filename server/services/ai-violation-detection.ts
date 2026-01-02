'use strict';
import OpenAI from 'openai';
import { storage } from '../storage';
import type { ContentViolation } from '@shared/schema';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface AIDetectedViolation {
  category: 'harassment' | 'hate_speech' | 'threats' | 'profanity' | 'scam' | 'inappropriate';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  excerpt: string;
}

interface AIAnalysisResult {
  hasViolations: boolean;
  violations: AIDetectedViolation[];
}

export async function analyzeTranscriptWithAI(
  callId: string,
  userId: string,
  transcript: string
): Promise<ContentViolation[]> {
  if (!transcript || transcript.trim().length === 0) {
    return [];
  }

  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️ [AI Violation Detection] OPENAI_API_KEY not configured, skipping AI analysis');
    return [];
  }

  try {
    console.log(`🤖 [AI Violation Detection] Analyzing transcript for call ${callId}`);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a content moderation AI that analyzes call transcripts for policy violations. 
Analyze the transcript and identify any violations in these categories:
- harassment: Personal attacks, bullying, intimidation
- hate_speech: Discriminatory language based on race, religion, gender, etc.
- threats: Direct or implied threats of violence or harm
- profanity: Excessive profane language or slurs
- scam: Attempts to defraud, misleading claims, phishing attempts
- inappropriate: Sexual content, explicit material, other inappropriate content

For each violation found, provide:
- category: One of the above categories
- severity: low (minor issue), medium (clear violation), high (serious violation), critical (immediate action needed)
- description: Brief explanation of the violation
- excerpt: The relevant portion of the transcript (max 100 chars)

Respond with a JSON object with this structure:
{
  "hasViolations": boolean,
  "violations": [
    {
      "category": "category_name",
      "severity": "severity_level", 
      "description": "description of violation",
      "excerpt": "relevant text excerpt"
    }
  ]
}

Only flag genuine policy violations. Normal business conversations, expressions of frustration, or declined offers are NOT violations.`
        },
        {
          role: 'user',
          content: `Analyze this call transcript for policy violations:\n\n${transcript}`
        }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.warn(`⚠️ [AI Violation Detection] No response from OpenAI for call ${callId}`);
      return [];
    }

    const result: AIAnalysisResult = JSON.parse(content);

    if (!result.hasViolations || !result.violations || result.violations.length === 0) {
      console.log(`✅ [AI Violation Detection] No violations found in call ${callId}`);
      return [];
    }

    console.log(`🔍 [AI Violation Detection] Found ${result.violations.length} violation(s) in call ${callId}`);

    const createdViolations: ContentViolation[] = [];

    for (const violation of result.violations) {
      const createdViolation = await storage.createContentViolation({
        callId,
        userId,
        detectedWord: `[AI] ${violation.category}`,
        severity: violation.severity,
        context: violation.excerpt,
        status: 'pending',
        notes: `AI Detection: ${violation.description}`,
      });

      createdViolations.push(createdViolation);

      if (violation.severity === 'critical') {
        const user = await storage.getUserById(userId);
        if (user && user.role !== 'admin' && user.isActive) {
          await storage.updateUser(userId, {
            isActive: false,
            blockedReason: `Auto-blocked: AI detected critical violation (${violation.category}: ${violation.description})`,
            blockedAt: new Date(),
            blockedBy: 'system',
          });
          console.log(`⚠️ [AI Violation Detection] Auto-blocked user ${userId} for critical violation: ${violation.category}`);
        }
      }
    }

    console.log(`💾 [AI Violation Detection] Stored ${createdViolations.length} violation(s) for call ${callId}`);
    return createdViolations;

  } catch (error: any) {
    console.error(`❌ [AI Violation Detection] Error analyzing call ${callId}:`, error.message);
    return [];
  }
}
