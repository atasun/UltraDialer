/**
 * Centralized Credit Deduction Service
 * 
 * Provides atomic, idempotent credit deduction across all telephony engines.
 * Standardizes transaction types and prevents double charging.
 */

import { db } from '../db';
import { users, creditTransactions } from '@shared/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';

export type CreditEngine = 'elevenlabs-twilio' | 'plivo-openai' | 'twilio-openai';

export interface CreditDeductionParams {
  userId: string;
  creditsToDeduct: number;
  callId: string;
  fromNumber: string;
  toNumber: string;
  durationSeconds: number;
  engine: CreditEngine;
}

export interface CreditDeductionResult {
  success: boolean;
  creditsDeducted: number;
  newBalance?: number;
  error?: string;
  alreadyDeducted?: boolean;
}

/**
 * Generate a unique, namespaced reference for idempotency.
 * Format: {engine}:{callId}
 */
function generateReference(engine: CreditEngine, callId: string): string {
  return `${engine}:${callId}`;
}

/**
 * Format a SIP endpoint to show a clean phone number with engine label
 * @param endpoint - The SIP URI or phone number (e.g., "sip:12708221598@sip.rtc.elevenlabs.io:5060;transport=tcp")
 * @returns Formatted string like "+12708221598 (ElevenLabs SIP)" or the original if not a SIP URI
 */
function formatSipEndpoint(endpoint: string | null | undefined): string {
  if (!endpoint) {
    return 'Unknown';
  }

  if (!endpoint.startsWith('sip:')) {
    return endpoint;
  }

  const sipMatch = endpoint.match(/^sip:(\+?\d+)@(.+?)(?::\d+)?(?:;.*)?$/);
  
  if (!sipMatch) {
    return endpoint;
  }

  const phoneNumber = sipMatch[1].startsWith('+') ? sipMatch[1] : `+${sipMatch[1]}`;
  const domain = sipMatch[2].toLowerCase();

  let engineLabel = 'SIP';
  if (domain.includes('elevenlabs')) {
    engineLabel = 'ElevenLabs SIP';
  } else if (domain.includes('openai')) {
    engineLabel = 'OpenAI SIP';
  }

  return `${phoneNumber} (${engineLabel})`;
}

/**
 * Atomically deducts credits from a user's balance with idempotency protection.
 * 
 * Features:
 * - Uses advisory lock to prevent concurrent deductions for same reference
 * - Atomic SQL update using GREATEST(0, credits - amount) to prevent negative balance
 * - Idempotent: Won't double-charge if called multiple times for same call
 * - Consistent transaction type: 'usage' with negative amount
 * - Per-user reference checking to prevent cross-tenant collisions
 */
export async function deductCallCredits(params: CreditDeductionParams): Promise<CreditDeductionResult> {
  const { userId, creditsToDeduct, callId, fromNumber, toNumber, durationSeconds, engine } = params;

  if (creditsToDeduct <= 0) {
    return { success: true, creditsDeducted: 0, alreadyDeducted: false };
  }

  const reference = generateReference(engine, callId);
  const description = `${engine.replace('-', '+')} call: ${formatSipEndpoint(fromNumber)} → ${formatSipEndpoint(toNumber)} (${durationSeconds}s)`;

  try {
    // Use database transaction with advisory lock for true atomic idempotency
    const result = await db.transaction(async (tx) => {
      // Generate deterministic lock keys using two 32-bit hashes
      // pg_advisory_xact_lock(int, int) accepts two 32-bit integers
      const userHash = hashCode32(userId);
      const refHash = hashCode32(reference);
      
      // Acquire advisory lock to serialize concurrent requests for this exact reference+userId
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userHash}, ${refHash})`);

      // Check for existing transaction with same reference AND userId (tenant isolation)
      const existingTransactions = await tx
        .select()
        .from(creditTransactions)
        .where(and(
          eq(creditTransactions.reference, reference),
          eq(creditTransactions.userId, userId)
        ));

      if (existingTransactions.length > 0) {
        logger.info(`Credits already deducted for ${reference} - skipping duplicate`, undefined, 'CreditService');
        return { 
          success: true, 
          creditsDeducted: 0, 
          alreadyDeducted: true 
        } as CreditDeductionResult;
      }

      // Lock the user row and get current balance atomically
      // This prevents concurrent calls for same user from racing
      const lockResult = await tx.execute(
        sql`SELECT credits FROM users WHERE id = ${userId} FOR UPDATE`
      );
      const currentCredits = Number(lockResult.rows?.[0]?.credits) || 0;
      const actualDeduction = Math.min(creditsToDeduct, currentCredits);

      // If user has insufficient credits (partial or zero), return failure to allow retry
      // This ensures no free calls - user must have FULL credits required
      if (actualDeduction < creditsToDeduct) {
        logger.warn(
          `[${engine}] Insufficient credits for ${reference}. Balance: ${currentCredits}, Requested: ${creditsToDeduct}`,
          undefined,
          'CreditService'
        );

        // Return failure so callers can handle appropriately
        // Don't record transaction to allow retry when credits are available
        return {
          success: false,
          creditsDeducted: 0,
          newBalance: currentCredits,
          alreadyDeducted: false,
          error: 'Insufficient credits',
        } as CreditDeductionResult;
      }

      // Atomically update user credits using actual deduction amount
      await tx
        .update(users)
        .set({
          credits: sql`${users.credits} - ${actualDeduction}`,
        })
        .where(eq(users.id, userId));

      // Record the credit transaction with actual deducted amount
      await tx.insert(creditTransactions).values({
        userId,
        type: 'usage',
        amount: -actualDeduction,
        description,
        reference,
      });

      // Get updated balance for logging
      const [updatedUser] = await tx
        .select({ credits: users.credits })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const newBalance = updatedUser?.credits || 0;

      logger.info(
        `[${engine}] Deducted ${actualDeduction} credits for ${reference}. New balance: ${newBalance}`,
        undefined,
        'CreditService'
      );

      return {
        success: true,
        creditsDeducted: actualDeduction,
        newBalance,
        alreadyDeducted: false,
      } as CreditDeductionResult;
    });

    return result;

  } catch (error: any) {
    // Handle unique constraint violation (double submission caught by DB)
    if (error.code === '23505' || error.message?.includes('duplicate')) {
      logger.info(`Credits already deducted for ${reference} (caught by constraint)`, undefined, 'CreditService');
      return {
        success: true,
        creditsDeducted: 0,
        alreadyDeducted: true,
      };
    }

    logger.error(`Failed to deduct credits for ${reference}: ${error.message}`, error, 'CreditService');
    return {
      success: false,
      creditsDeducted: 0,
      error: error.message,
    };
  }
}

/**
 * Generate a deterministic 32-bit signed integer hash for PostgreSQL advisory locks.
 * Uses djb2 hash algorithm for good distribution within 32-bit range.
 */
function hashCode32(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash | 0; // Convert to 32-bit integer
  }
  return hash;
}

/**
 * Check if a user has sufficient credits for a call.
 */
export async function checkSufficientCredits(userId: string, requiredCredits: number = 1): Promise<boolean> {
  try {
    const [user] = await db
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return (user?.credits || 0) >= requiredCredits;
  } catch (error: any) {
    logger.error(`Failed to check credits for user ${userId}: ${error.message}`, error, 'CreditService');
    return false;
  }
}

/**
 * Get user's current credit balance.
 */
export async function getUserCredits(userId: string): Promise<number> {
  try {
    const [user] = await db
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return user?.credits || 0;
  } catch (error: any) {
    logger.error(`Failed to get credits for user ${userId}: ${error.message}`, error, 'CreditService');
    return 0;
  }
}

export type RefundGateway = 'stripe' | 'razorpay' | 'paypal' | 'paystack' | 'mercadopago';

export interface RefundParams {
  userId: string;
  creditsToReverse: number;
  gateway: RefundGateway;
  gatewayRefundId: string;
  transactionId: string;
  reason?: string;
}

export interface RefundResult {
  success: boolean;
  creditsReversed: number;
  newBalance?: number;
  transactionId?: string;
  error?: string;
  alreadyProcessed?: boolean;
}

/**
 * Atomically reverses credits for a refund with transaction logging.
 * 
 * Features:
 * - Uses advisory lock to prevent concurrent refunds for same gateway refund
 * - Idempotent: Won't double-process if called multiple times for same refund
 * - Creates audit trail in credit_transactions table
 * - Uses negative amount to indicate credit reversal
 */
export async function applyRefund(params: RefundParams): Promise<RefundResult> {
  const { userId, creditsToReverse, gateway, gatewayRefundId, transactionId, reason } = params;

  if (creditsToReverse <= 0) {
    return { success: true, creditsReversed: 0, alreadyProcessed: false };
  }

  const reference = `refund:${gateway}:${gatewayRefundId}`;
  const description = reason 
    ? `${gateway.charAt(0).toUpperCase() + gateway.slice(1)} refund: ${reason}` 
    : `${gateway.charAt(0).toUpperCase() + gateway.slice(1)} refund for transaction ${transactionId}`;

  try {
    const result = await db.transaction(async (tx) => {
      // Generate deterministic lock keys for this refund
      const userHash = hashCode32(userId);
      const refHash = hashCode32(reference);
      
      // Acquire advisory lock to serialize concurrent requests for this exact refund
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userHash}, ${refHash})`);

      // Check for existing refund transaction (idempotency)
      const existingTransactions = await tx
        .select()
        .from(creditTransactions)
        .where(and(
          eq(creditTransactions.reference, reference),
          eq(creditTransactions.userId, userId)
        ));

      if (existingTransactions.length > 0) {
        logger.info(`Refund already processed for ${reference} - skipping duplicate`, undefined, 'CreditService');
        return { 
          success: true, 
          creditsReversed: 0, 
          alreadyProcessed: true 
        } as RefundResult;
      }

      // Lock the user row and get current balance
      const lockResult = await tx.execute(
        sql`SELECT credits FROM users WHERE id = ${userId} FOR UPDATE`
      );
      const currentCredits = Number(lockResult.rows?.[0]?.credits) || 0;
      
      // Deduct credits (can't go below 0)
      const actualReversal = Math.min(creditsToReverse, currentCredits);

      // Update user credits
      const newBalance = Math.max(0, currentCredits - actualReversal);
      await tx
        .update(users)
        .set({ credits: newBalance })
        .where(eq(users.id, userId));

      // Record the refund transaction (negative amount)
      const [insertedTransaction] = await tx.insert(creditTransactions).values({
        userId,
        type: 'refund',
        amount: -actualReversal,
        description,
        reference,
      }).returning();

      logger.info(
        `[${gateway}] Reversed ${actualReversal} credits for refund ${gatewayRefundId}. New balance: ${newBalance}`,
        undefined,
        'CreditService'
      );

      return {
        success: true,
        creditsReversed: actualReversal,
        newBalance,
        transactionId: insertedTransaction?.id,
        alreadyProcessed: false,
      } as RefundResult;
    });

    return result;

  } catch (error: any) {
    // Handle unique constraint violation (double submission caught by DB)
    if (error.code === '23505' || error.message?.includes('duplicate')) {
      logger.info(`Refund already processed for ${reference} (caught by constraint)`, undefined, 'CreditService');
      return {
        success: true,
        creditsReversed: 0,
        alreadyProcessed: true,
      };
    }

    logger.error(`Failed to apply refund for ${reference}: ${error.message}`, error, 'CreditService');
    return {
      success: false,
      creditsReversed: 0,
      error: error.message,
    };
  }
}
