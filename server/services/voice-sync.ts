/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import { db } from "../db";
import { syncedVoices, elevenLabsCredentials } from "@shared/schema";
import { eq, and } from "drizzle-orm";

const DEFAULT_VOICE_IDS = [
  "21m00Tcm4TlvDq8ikWAM", // Rachel
  "CYw3kZ02Hs0563khs1Fj", // Dave
  "CwhRBWXzGAHq8TQ4Fs17", // Roger
  "IKne3meq5aSn9XLyUdCD", // Charlie
  "SAz9YHcvj6GT2YYXdXww", // River
  "bIHbv24MWmeRgasZH58o", // Will
  "cgSgspJ2msm6clMCkdW9", // Jessica
  "cjVigY5qzO86Huf0OWal", // Eric
  "iP95p4xoKVk53GoZ742B", // Chris
  "EXAVITQu4vr4xnSDxMaL", // Bella
  "ErXwobaYiN019PkySvjV", // Antoni
  "MF3mGyEYCl7XYWbV9V6O", // Elli
  "TxGEqnHWrfWFTfGW9XjX", // Josh
  "VR6AewLTigWG4xSOukaG", // Arnold
  "pNInz6obpgDQGcFmaJgB", // Adam
  "yoZ06aMxZJJ28mfd3POQ", // Sam
  "jBpfuIE2acCO8z3wKNLl", // Gigi
  "jsCqWAovK2LkecY7zXl4", // Freya
];

export class VoiceSyncService {
  static isDefaultVoice(voiceId: string): boolean {
    return DEFAULT_VOICE_IDS.includes(voiceId);
  }

  static async isVoiceSynced(credentialId: string, voiceId: string): Promise<boolean> {
    const existing = await db
      .select()
      .from(syncedVoices)
      .where(
        and(
          eq(syncedVoices.credentialId, credentialId),
          eq(syncedVoices.voiceId, voiceId)
        )
      )
      .limit(1);
    
    return existing.length > 0 && existing[0].status === "synced";
  }

  static async syncVoiceToCredential(
    voiceId: string,
    publicOwnerId: string,
    voiceName: string | null,
    credential: { id: string; apiKey: string }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const alreadySynced = await this.isVoiceSynced(credential.id, voiceId);
      if (alreadySynced) {
        console.log(`🔊 Voice ${voiceId} already synced to credential ${credential.id}`);
        return { success: true };
      }

      console.log(`🔊 Syncing voice ${voiceId} (${voiceName || 'unknown'}) to credential ${credential.id}...`);

      const response = await fetch(
        `https://api.elevenlabs.io/v1/voices/add/${publicOwnerId}/${voiceId}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": credential.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            new_name: voiceName || undefined,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Failed to sync voice ${voiceId}: ${response.status} - ${errorText}`);
        
        await db.insert(syncedVoices).values({
          credentialId: credential.id,
          voiceId,
          publicOwnerId,
          voiceName,
          status: "failed",
          errorMessage: `${response.status}: ${errorText}`,
        }).onConflictDoUpdate({
          target: [syncedVoices.credentialId, syncedVoices.voiceId],
          set: {
            status: "failed",
            errorMessage: `${response.status}: ${errorText}`,
          },
        });
        
        return { success: false, error: errorText };
      }

      await db.insert(syncedVoices).values({
        credentialId: credential.id,
        voiceId,
        publicOwnerId,
        voiceName,
        status: "synced",
      }).onConflictDoUpdate({
        target: [syncedVoices.credentialId, syncedVoices.voiceId],
        set: {
          status: "synced",
          errorMessage: null,
        },
      });

      console.log(`✅ Voice ${voiceId} synced successfully to credential ${credential.id}`);
      return { success: true };
    } catch (error) {
      console.error(`❌ Error syncing voice ${voiceId}:`, error);
      return { success: false, error: String(error) };
    }
  }

  static async syncVoiceToAllCredentials(
    voiceId: string,
    publicOwnerId: string,
    voiceName: string | null
  ): Promise<{ synced: number; failed: number; skipped: number }> {
    if (this.isDefaultVoice(voiceId)) {
      console.log(`🔊 Voice ${voiceId} is a default voice, skipping sync`);
      return { synced: 0, failed: 0, skipped: 1 };
    }

    const activeCredentials = await db
      .select()
      .from(elevenLabsCredentials)
      .where(eq(elevenLabsCredentials.isActive, true));

    if (activeCredentials.length === 0) {
      console.log("⚠️ No active ElevenLabs credentials found for voice sync");
      return { synced: 0, failed: 0, skipped: 0 };
    }

    console.log(`🔊 Starting sync of voice ${voiceId} to ${activeCredentials.length} credentials...`);

    let synced = 0;
    let failed = 0;

    for (const credential of activeCredentials) {
      const result = await this.syncVoiceToCredential(
        voiceId,
        publicOwnerId,
        voiceName,
        credential
      );

      if (result.success) {
        synced++;
      } else {
        failed++;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`🔊 Voice sync complete: ${synced} synced, ${failed} failed`);
    return { synced, failed, skipped: 0 };
  }

  static async getSyncedVoicesForCredential(credentialId: string) {
    return db
      .select()
      .from(syncedVoices)
      .where(eq(syncedVoices.credentialId, credentialId));
  }

  static async getVoiceSyncStatus(voiceId: string) {
    return db
      .select()
      .from(syncedVoices)
      .where(eq(syncedVoices.voiceId, voiceId));
  }

  static async retryFailedSyncs(voiceId: string, publicOwnerId: string, voiceName: string | null) {
    const failedSyncs = await db
      .select({
        syncedVoice: syncedVoices,
        credential: elevenLabsCredentials,
      })
      .from(syncedVoices)
      .innerJoin(elevenLabsCredentials, eq(syncedVoices.credentialId, elevenLabsCredentials.id))
      .where(
        and(
          eq(syncedVoices.voiceId, voiceId),
          eq(syncedVoices.status, "failed"),
          eq(elevenLabsCredentials.isActive, true)
        )
      );

    let retried = 0;
    let succeeded = 0;

    for (const { credential } of failedSyncs) {
      retried++;
      const result = await this.syncVoiceToCredential(
        voiceId,
        publicOwnerId,
        voiceName,
        credential
      );
      if (result.success) {
        succeeded++;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return { retried, succeeded };
  }
}
