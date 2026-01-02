'use strict';
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

import { Router, Request, Response } from "express";
import { RouteContext, AuthRequest } from "./common";
import { eq } from "drizzle-orm";
import { 
  campaigns, contacts, calls, agents, phoneNumbers, incomingConnections, sipPhoneNumbers 
} from "@shared/schema";
import { ElevenLabsService } from "../services/elevenlabs";
import { ElevenLabsPoolService } from "../services/elevenlabs-pool";
import { BatchCallingService } from "../services/batch-calling";
import { PlanLimitExceededError } from "../services/contact-upload-service";

export function createCampaignRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { 
    db, storage, authenticateToken, authenticateHybrid, upload, escapeCSV,
    campaignExecutor, webhookDeliveryService, contactUploadService
  } = ctx;

  // Get all campaigns
  router.get("/api/campaigns", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const allCampaigns = await storage.getUserCampaigns(req.userId!);
      const deletedCampaigns = await storage.getUserDeletedCampaigns(req.userId!);
      
      const activeCount = allCampaigns.length;
      const deletedCount = deletedCampaigns.length;

      const requestsPagination = req.query.page !== undefined || req.query.pageSize !== undefined;
      
      if (requestsPagination) {
        const page = parseInt(req.query.page as string, 10) || 1;
        const pageSize = parseInt(req.query.pageSize as string, 10) || 25;
        const offset = (page - 1) * pageSize;

        const totalItems = allCampaigns.length;
        const totalPages = Math.ceil(totalItems / pageSize);

        const paginatedCampaigns = allCampaigns.slice(offset, offset + pageSize);

        res.json({
          data: paginatedCampaigns,
          pagination: {
            page,
            pageSize,
            totalItems,
            totalPages
          }
        });
      } else {
        res.json(allCampaigns);
      }
    } catch (error: any) {
      console.error("Get campaigns error:", error);
      res.status(500).json({ error: "Failed to get campaigns" });
    }
  });

  // Get deleted campaigns
  router.get("/api/campaigns/deleted", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const deletedCampaigns = await storage.getUserDeletedCampaigns(req.userId!);
      res.json(deletedCampaigns);
    } catch (error: any) {
      console.error("Get deleted campaigns error:", error);
      res.status(500).json({ error: "Failed to get deleted campaigns" });
    }
  });

  // Restore a deleted campaign
  router.patch("/api/campaigns/:id/restore", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaignIncludingDeleted(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      if (!campaign.deletedAt) {
        return res.status(400).json({ error: "Campaign is not deleted" });
      }
      
      await storage.restoreCampaign(req.params.id);
      
      const restoredCampaign = await storage.getCampaign(req.params.id);
      res.json(restoredCampaign);
    } catch (error: any) {
      console.error("Restore campaign error:", error);
      res.status(500).json({ error: "Failed to restore campaign" });
    }
  });

  // Create campaign
  router.post("/api/campaigns", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { name, type, goal, script, flowId, agentId, voiceId, phoneNumberId, sipPhoneNumberId, scheduledFor } = req.body;

      if (!name || !type) {
        return res.status(400).json({ error: "Name and type are required" });
      }

      if (!agentId) {
        return res.status(400).json({ error: "Please select an agent for this campaign" });
      }

      if (flowId && script) {
        return res.status(400).json({ error: "Cannot use both visual flow and custom script. Please choose one." });
      }

      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const plan = await storage.getPlanByName(user.planType || 'free');
      if (!plan) {
        return res.status(500).json({ error: "Plan configuration not found" });
      }

      const existingCampaigns = await storage.getUserCampaigns(req.userId!);
      if (existingCampaigns.length >= plan.maxCampaigns) {
        return res.status(403).json({ 
          error: `Campaign limit reached. Your ${plan.displayName} allows maximum ${plan.maxCampaigns} campaign(s).`,
          upgradeRequired: true
        });
      }

      const agent = await storage.getAgent(agentId);
      if (!agent || agent.userId !== req.userId) {
        return res.status(403).json({ error: "Invalid agent selection" });
      }

      if (phoneNumberId) {
        const phoneNumber = await storage.getPhoneNumber(phoneNumberId);
        if (!phoneNumber) {
          return res.status(403).json({ error: "Invalid phone number selection" });
        }
        
        const isOwned = phoneNumber.userId === req.userId;
        const isSystemPool = phoneNumber.userId === null && phoneNumber.isSystemPool === true;
        
        if (isSystemPool && user.planType === 'pro') {
          return res.status(403).json({ 
            error: "Pro users cannot use system numbers",
            message: "As a Pro plan user, please purchase your own phone number for campaigns. System pool numbers are only available for Free plan users."
          });
        }
        
        if (!isOwned && !isSystemPool) {
          return res.status(403).json({ error: "Invalid phone number selection" });
        }

        const incomingConnectionCheck = await db
          .select({ id: incomingConnections.id, agentId: incomingConnections.agentId })
          .from(incomingConnections)
          .where(eq(incomingConnections.phoneNumberId, phoneNumberId))
          .limit(1);
        
        if (incomingConnectionCheck.length > 0) {
          const [connectedAgent] = await db
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, incomingConnectionCheck[0].agentId))
            .limit(1);
          
          return res.status(409).json({ 
            error: "Phone number conflict",
            message: `This phone number is attached to an incoming connection for "${connectedAgent?.name || 'an agent'}". A phone number cannot be used for both outbound campaigns and incoming calls simultaneously. Please either buy a new number for campaigns, or detach this number from the incoming connection first.`,
            conflictType: 'incoming_connection',
            connectedAgentName: connectedAgent?.name
          });
        }
      }

      // Validate SIP phone number if provided
      if (sipPhoneNumberId) {
        const [sipPhoneNumber] = await db
          .select()
          .from(sipPhoneNumbers)
          .where(eq(sipPhoneNumbers.id, sipPhoneNumberId))
          .limit(1);

        if (!sipPhoneNumber) {
          return res.status(404).json({ error: "SIP phone number not found" });
        }

        // Validate ownership
        if (sipPhoneNumber.userId !== req.userId) {
          return res.status(403).json({ error: "You don't have access to this SIP phone number" });
        }

        // Validate engine compatibility with agent
        if (agent.telephonyProvider && sipPhoneNumber.engine !== agent.telephonyProvider) {
          return res.status(400).json({ 
            error: "Engine mismatch",
            message: `The selected SIP phone number uses ${sipPhoneNumber.engine} engine but the agent uses ${agent.telephonyProvider}. Please select a compatible phone number.`
          });
        }
      }

      const campaign = await storage.createCampaign({
        userId: req.userId!,
        agentId,
        voiceId: voiceId || null,
        phoneNumberId: phoneNumberId || null,
        sipPhoneNumberId: sipPhoneNumberId || null,
        flowId: flowId || null,
        name,
        type,
        goal: goal || null,
        script: script || null,
        status: "pending",
        totalContacts: 0,
        scheduledFor: scheduledFor || null,
        startedAt: null,
        completedAt: null,
      });

      res.json(campaign);
    } catch (error: any) {
      console.error("Create campaign error:", error);
      res.status(500).json({ error: "Failed to create campaign" });
    }
  });

  // Get single campaign
  router.get("/api/campaigns/:id", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      res.json(campaign);
    } catch (error: any) {
      console.error("Get campaign error:", error);
      res.status(500).json({ error: "Failed to get campaign" });
    }
  });

  // Export campaign data
  router.get("/api/campaigns/:id/export", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const callsList = await storage.getCampaignCalls(campaign.id);
      
      const contactIds = callsList.map(c => c.contactId).filter(Boolean) as string[];
      const uniqueContactIds = Array.from(new Set(contactIds));
      const contactsArray = await Promise.all(
        uniqueContactIds.map(id => storage.getContact(id))
      );
      
      const contactMap = new Map(
        contactsArray.filter(Boolean).map(c => [c!.id, c])
      );
      
      const headers = [
        "Contact Name",
        "Phone Number",
        "Email",
        "Call Status",
        "Lead Classification",
        "Duration (seconds)",
        "Call Started",
        "Call Ended",
        "Transcript",
        "AI Summary",
        "Error Message"
      ];

      const csvRows = [headers.join(",")];

      for (const call of callsList) {
        const contact = call.contactId ? contactMap.get(call.contactId) : undefined;
        const fullName = contact ? `${contact.firstName} ${contact.lastName || ""}`.trim() : "";
        const phone = contact?.phone || "";
        const email = contact?.email || "";
        
        const row = [
          escapeCSV(fullName),
          escapeCSV(phone),
          escapeCSV(email),
          escapeCSV(call.status || ""),
          escapeCSV(call.classification || ""),
          call.duration || 0,
          escapeCSV(call.startedAt ? new Date(call.startedAt).toISOString() : ""),
          escapeCSV(call.endedAt ? new Date(call.endedAt).toISOString() : ""),
          escapeCSV(call.transcript || ""),
          escapeCSV(call.aiSummary || ""),
          ""
        ];
        
        csvRows.push(row.join(","));
      }

      const csv = csvRows.join("\n");
      const filename = `campaign-${campaign.name.replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().split('T')[0]}.csv`;
      
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error: any) {
      console.error("Export campaign error:", error);
      res.status(500).json({ error: "Failed to export campaign" });
    }
  });

  // Update campaign
  router.patch("/api/campaigns/:id", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const { agentId, voiceId, phoneNumberId, name, type, goal, script } = req.body;

      if (agentId) {
        const agent = await storage.getAgent(agentId);
        if (!agent || agent.userId !== req.userId) {
          return res.status(403).json({ error: "Invalid agent selection" });
        }
      }

      if (phoneNumberId) {
        const phoneNumber = await storage.getPhoneNumber(phoneNumberId);
        if (!phoneNumber || phoneNumber.userId !== req.userId) {
          return res.status(403).json({ error: "Invalid phone number selection" });
        }
      }

      await storage.updateCampaign(req.params.id, req.body);
      const updated = await storage.getCampaign(req.params.id);
      res.json(updated);
    } catch (error: any) {
      console.error("Update campaign error:", error);
      res.status(500).json({ error: "Failed to update campaign" });
    }
  });

  // Delete campaign
  router.delete("/api/campaigns/:id", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      await storage.deleteCampaign(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Delete campaign error:", error);
      res.status(500).json({ error: "Failed to delete campaign" });
    }
  });

  // Get campaign contacts
  router.get("/api/campaigns/:campaignId/contacts", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.campaignId);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const contactsList = await storage.getCampaignContacts(req.params.campaignId);
      res.json(contactsList);
    } catch (error: any) {
      console.error("Get contacts error:", error);
      res.status(500).json({ error: "Failed to get contacts" });
    }
  });

  // Upload contacts to campaign
  router.post("/api/campaigns/:campaignId/contacts/upload", authenticateToken, upload.single("file"), async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.campaignId);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const plan = await storage.getPlanByName(user.planType || 'free');
      if (!plan) {
        return res.status(500).json({ error: "Plan configuration not found" });
      }

      const fileContent = await contactUploadService.readFileContent(req.file);
      const parsedContacts = contactUploadService.parseContactsFromCSV(fileContent, req.params.campaignId);

      contactUploadService.validateContactsAgainstPlanLimit(
        parsedContacts.length,
        campaign.totalContacts,
        plan.maxContactsPerCampaign,
        plan.displayName
      );

      const createdContacts = await contactUploadService.createContactsForCampaign(
        req.params.campaignId,
        parsedContacts,
        campaign.totalContacts
      );

      res.json({ count: createdContacts.length, contacts: createdContacts });
    } catch (error: any) {
      if (error instanceof PlanLimitExceededError) {
        return res.status(403).json({
          error: error.message,
          upgradeRequired: error.upgradeRequired,
          currentContacts: error.currentContacts,
          maxContacts: error.maxContacts
        });
      }
      console.error("Upload contacts error:", error);
      res.status(500).json({ error: "Failed to upload contacts" });
    }
  });

  // Get campaign calls
  router.get("/api/campaigns/:campaignId/calls", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.campaignId);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const callsList = await storage.getCampaignCalls(req.params.campaignId);
      res.json(callsList);
    } catch (error: any) {
      console.error("Get campaign calls error:", error);
      res.status(500).json({ error: "Failed to get campaign calls" });
    }
  });

  // Get campaign batch job (campaignId param version)
  router.get("/api/campaigns/:campaignId/batch", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.campaignId);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      if (!campaign.batchJobId) {
        return res.status(404).json({ error: "No batch job associated with this campaign" });
      }

      if (!campaign.agentId) {
        return res.status(400).json({ error: "Campaign has no agent assigned" });
      }

      const agent = await storage.getAgent(campaign.agentId);
      if (!agent) {
        return res.status(400).json({ error: "Agent not found" });
      }

      const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
      if (!credential) {
        return res.status(500).json({ error: "No credential found for agent" });
      }

      const batchService = new BatchCallingService(credential.apiKey);
      const batchJob = await batchService.getBatch(campaign.batchJobId);
      const stats = BatchCallingService.getBatchStats(batchJob);

      res.json({ batchJob, stats });
    } catch (error: any) {
      console.error("Get batch job error:", error);
      res.status(500).json({ error: error.message || "Failed to get batch job status" });
    }
  });

  // Cancel campaign batch job
  router.post("/api/campaigns/:campaignId/batch/cancel", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.campaignId);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      if (!campaign.batchJobId) {
        return res.status(400).json({ error: "No batch job to cancel" });
      }

      if (!campaign.agentId) {
        return res.status(400).json({ error: "Campaign has no agent assigned" });
      }

      const agent = await storage.getAgent(campaign.agentId);
      if (!agent) {
        return res.status(400).json({ error: "Agent not found" });
      }

      const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
      if (!credential) {
        return res.status(500).json({ error: "No credential found for agent" });
      }

      const batchService = new BatchCallingService(credential.apiKey);
      const result = await batchService.cancelBatch(campaign.batchJobId);

      await storage.updateCampaign(campaign.id, {
        status: 'cancelled',
        batchJobStatus: 'cancelled',
      });

      res.json({ success: true, result });
    } catch (error: any) {
      console.error("Cancel batch job error:", error);
      res.status(500).json({ error: error.message || "Failed to cancel batch job" });
    }
  });

  // Retry campaign batch job
  router.post("/api/campaigns/:campaignId/batch/retry", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.campaignId);
      if (!campaign || campaign.userId !== req.userId) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      if (!campaign.batchJobId) {
        return res.status(400).json({ error: "No batch job to retry" });
      }

      if (!campaign.agentId) {
        return res.status(400).json({ error: "Campaign has no agent assigned" });
      }

      const agent = await storage.getAgent(campaign.agentId);
      if (!agent) {
        return res.status(400).json({ error: "Agent not found" });
      }

      const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
      if (!credential) {
        return res.status(500).json({ error: "No credential found for agent" });
      }

      const batchService = new BatchCallingService(credential.apiKey);
      const result = await batchService.retryBatch(campaign.batchJobId);

      await storage.updateCampaign(campaign.id, {
        status: 'in-progress',
        batchJobStatus: 'in_progress',
      });

      res.json({ success: true, result });
    } catch (error: any) {
      console.error("Retry batch job error:", error);
      res.status(500).json({ error: error.message || "Failed to retry batch job" });
    }
  });

  // Validate campaign before execution
  router.get("/api/campaigns/:id/validate", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      const validation = await campaignExecutor.validateCampaign(id);
      
      res.json({
        valid: validation.valid,
        errors: validation.errors,
        warnings: validation.warnings,
        canStart: validation.valid,
      });
    } catch (error: any) {
      console.error("Campaign validation error:", error);
      res.status(500).json({ error: error.message || "Failed to validate campaign" });
    }
  });

  // Execute campaign
  router.post("/api/campaigns/:id/execute", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (campaign.status !== 'pending' && campaign.status !== 'draft' && campaign.status !== 'scheduled') {
        return res.status(400).json({ error: "Campaign is already running or completed" });
      }
      
      if (!campaign.agentId || !campaign.voiceId || !campaign.phoneNumberId) {
        return res.status(400).json({ error: "Campaign must have agent, voice, and phone number configured" });
      }
      
      const incomingConnectionCheck = await db
        .select({ id: incomingConnections.id, agentId: incomingConnections.agentId })
        .from(incomingConnections)
        .where(eq(incomingConnections.phoneNumberId, campaign.phoneNumberId))
        .limit(1);
      
      if (incomingConnectionCheck.length > 0) {
        const [connectedAgent] = await db
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.id, incomingConnectionCheck[0].agentId))
          .limit(1);
        
        return res.status(409).json({
          error: "Phone number conflict",
          message: `This phone number is attached to an incoming agent "${connectedAgent?.name || 'Unknown'}". A phone number can only be used for either incoming calls OR outbound campaigns, not both.`,
          suggestion: "Please either purchase a new phone number for this campaign, or disconnect this number from the incoming agent first.",
          conflictType: "incoming_connection",
          connectedAgentName: connectedAgent?.name
        });
      }
      
      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      const totalContacts = campaign.totalContacts || 0;
      if (totalContacts === 0) {
        return res.status(400).json({ error: "Campaign has no contacts. Please add contacts before starting." });
      }
      
      const estimatedMinutes = totalContacts * 2;
      const estimatedCredits = estimatedMinutes;
      
      if (user.credits < estimatedCredits) {
        return res.status(402).json({ 
          error: "Insufficient credits",
          message: `You need approximately ${estimatedCredits} credits to run this campaign (${totalContacts} contacts × ~2 min/call). You currently have ${user.credits} credits. Please purchase more credits to continue.`,
          required: estimatedCredits,
          available: user.credits
        });
      }
      
      const result = await campaignExecutor.executeCampaign(id);
      
      webhookDeliveryService.triggerEvent(req.userId!, 'campaign.started', {
        campaign: { 
          id: campaign.id, 
          name: campaign.name, 
          type: campaign.type,
          totalContacts: campaign.totalContacts,
          agentId: campaign.agentId,
          phoneNumberId: campaign.phoneNumberId,
        },
        startedAt: new Date().toISOString(),
        totalCallsScheduled: result.batchJob.total_calls_scheduled,
        batchJobId: result.batchJob.id,
      }, id).catch(err => {
        console.error('❌ [Webhook] Error triggering campaign.started event:', err);
      });
      
      res.json({ 
        message: "Campaign started with batch job", 
        campaignId: id,
        batchJobId: result.batchJob.id,
        batchJobStatus: result.batchJob.status,
        totalCallsScheduled: result.batchJob.total_calls_scheduled,
        estimatedCredits,
        availableCredits: user.credits
      });
    } catch (error: any) {
      console.error("Campaign execution error:", error);
      res.status(500).json({ error: error.message || "Failed to execute campaign" });
    }
  });

  // Cancel campaign
  router.post("/api/campaigns/:id/cancel", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (!campaign.batchJobId) {
        return res.status(400).json({ error: "Campaign has no active batch job to cancel" });
      }
      
      const batchJob = await campaignExecutor.cancelCampaign(id);
      
      res.json({ 
        message: "Campaign cancelled", 
        campaignId: id,
        batchJob
      });
    } catch (error: any) {
      console.error("Campaign cancel error:", error);
      res.status(500).json({ error: error.message || "Failed to cancel campaign" });
    }
  });

  // Retry campaign
  router.post("/api/campaigns/:id/retry", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (!campaign.batchJobId) {
        return res.status(400).json({ error: "Campaign has no batch job to retry" });
      }
      
      const batchJob = await campaignExecutor.retryCampaign(id);
      
      res.json({ 
        message: "Campaign retry started", 
        campaignId: id,
        batchJob
      });
    } catch (error: any) {
      console.error("Campaign retry error:", error);
      res.status(500).json({ error: error.message || "Failed to retry campaign" });
    }
  });

  // Stop campaign (legacy)
  router.post("/api/campaigns/:id/stop", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (campaign.batchJobId) {
        await campaignExecutor.cancelCampaign(id);
      } else {
        await campaignExecutor.stopCampaign(id);
      }
      
      res.json({ message: "Campaign stopped", campaignId: id });
    } catch (error: any) {
      console.error("Campaign stop error:", error);
      res.status(500).json({ error: error.message || "Failed to stop campaign" });
    }
  });

  // Pause campaign
  router.post("/api/campaigns/:id/pause", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (campaign.status !== "running" && campaign.status !== "in-progress" && campaign.status !== "in_progress") {
        return res.status(400).json({ error: "Campaign is not running" });
      }
      
      if (campaign.batchJobId) {
        const batchJob = await campaignExecutor.pauseCampaign(id, 'manual');
        res.json({ 
          message: "Campaign paused", 
          campaignId: id,
          batchJob
        });
      } else {
        await storage.updateCampaign(id, {
          status: "paused",
        });
        
        webhookDeliveryService.triggerEvent(req.userId!, 'campaign.paused', {
          campaign: { 
            id: campaign.id, 
            name: campaign.name,
            type: campaign.type,
            totalContacts: campaign.totalContacts,
            completedCalls: campaign.completedCalls,
            successfulCalls: campaign.successfulCalls,
            failedCalls: campaign.failedCalls,
          },
          pausedAt: new Date().toISOString(),
          reason: 'manual',
        }, id).catch(err => {
          console.error('❌ [Webhook] Error triggering campaign.paused event:', err);
        });
        
        res.json({ message: "Campaign paused", campaignId: id });
      }
    } catch (error: any) {
      console.error("Campaign pause error:", error);
      res.status(500).json({ error: error.message || "Failed to pause campaign" });
    }
  });

  // Resume campaign
  router.post("/api/campaigns/:id/resume", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (campaign.status !== "paused" && campaign.status !== "completed" && campaign.status !== "failed") {
        return res.status(400).json({ error: "Campaign cannot be resumed. Must be paused, completed, or failed." });
      }

      if (campaign.phoneNumberId) {
        const incomingConnectionCheck = await db
          .select({ id: incomingConnections.id, agentId: incomingConnections.agentId })
          .from(incomingConnections)
          .where(eq(incomingConnections.phoneNumberId, campaign.phoneNumberId))
          .limit(1);
        
        if (incomingConnectionCheck.length > 0) {
          const [connectedAgent] = await db
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, incomingConnectionCheck[0].agentId))
            .limit(1);
          
          return res.status(409).json({
            error: "Phone number conflict",
            message: `This phone number is attached to an incoming agent "${connectedAgent?.name || 'Unknown'}". A phone number can only be used for either incoming calls OR outbound campaigns, not both.`,
            suggestion: "Please either purchase a new phone number for this campaign, or disconnect this number from the incoming agent first.",
            conflictType: "incoming_connection",
            connectedAgentName: connectedAgent?.name
          });
        }
      }
      
      if (campaign.batchJobId) {
        const batchJob = await campaignExecutor.resumeCampaign(id, 'manual');
        res.json({ 
          message: "Campaign resumed", 
          campaignId: id,
          batchJob
        });
      } else {
        await storage.updateCampaign(id, {
          status: "running",
        });
        
        webhookDeliveryService.triggerEvent(req.userId!, 'campaign.started', {
          campaign: { 
            id: campaign.id, 
            name: campaign.name,
            type: campaign.type,
            totalContacts: campaign.totalContacts,
            completedCalls: campaign.completedCalls,
            successfulCalls: campaign.successfulCalls,
            failedCalls: campaign.failedCalls,
          },
          resumedAt: new Date().toISOString(),
          isResume: true,
        }, id).catch(err => {
          console.error('❌ [Webhook] Error triggering campaign.started (resumed) event:', err);
        });
        
        res.json({ message: "Campaign resumed", campaignId: id });
      }
    } catch (error: any) {
      console.error("Campaign resume error:", error);
      res.status(500).json({ error: error.message || "Failed to resume campaign" });
    }
  });

  // Test call for campaign
  router.post("/api/campaigns/:id/test-call", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { phoneNumber } = req.body;

      const campaign = await storage.getCampaign(id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      if (campaign.userId !== req.userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      if (!phoneNumber) {
        return res.status(400).json({ error: "Phone number is required" });
      }

      if (!phoneNumber.startsWith('+')) {
        return res.status(400).json({ error: "Phone number must include country code (e.g., +1234567890)" });
      }

      if (!campaign.phoneNumberId) {
        return res.status(400).json({ error: "Campaign must have a phone number configured" });
      }

      const [campaignPhone] = await db
        .select()
        .from(phoneNumbers)
        .where(eq(phoneNumbers.id, campaign.phoneNumberId))
        .limit(1);

      if (!campaignPhone) {
        return res.status(404).json({ error: "Campaign phone number not found" });
      }

      if (!campaignPhone.elevenLabsPhoneNumberId) {
        return res.status(400).json({ error: "Phone number not synced with ElevenLabs. Please sync your phone numbers first." });
      }

      if (!campaign.agentId) {
        return res.status(400).json({ error: "Campaign must have an agent configured" });
      }

      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, campaign.agentId))
        .limit(1);

      if (!agent || !agent.elevenLabsAgentId) {
        return res.status(400).json({ error: "Agent not found or not synced with ElevenLabs" });
      }

      const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
      if (!credential) {
        return res.status(500).json({ error: "No ElevenLabs credential found for agent" });
      }

      console.log(`📞 [Test Call] Initiating test call via ElevenLabs native API`);
      console.log(`   Campaign: ${campaign.name} (${campaign.id})`);
      console.log(`   To: ${phoneNumber}`);
      console.log(`   From: ${campaignPhone.phoneNumber} (ElevenLabs ID: ${campaignPhone.elevenLabsPhoneNumberId})`);
      console.log(`   Agent: ${agent.name} (ElevenLabs ID: ${agent.elevenLabsAgentId})`);
      console.log(`   Credential: ${credential.name}`);

      const [callRecord] = await db
        .insert(calls)
        .values({
          userId: campaign.userId,
          campaignId: campaign.id,
          contactId: null,
          phoneNumber: phoneNumber,
          status: 'initiated',
          callDirection: 'outgoing',
          startedAt: new Date(),
        })
        .returning();

      const elevenLabsSvc = new ElevenLabsService(credential.apiKey);
      
      try {
        const callResult = await elevenLabsSvc.initiateOutboundCall({
          phoneNumberId: campaignPhone.elevenLabsPhoneNumberId,
          toNumber: phoneNumber,
          agentId: agent.elevenLabsAgentId,
          firstMessage: agent.firstMessage || undefined,
        });

        console.log(`✅ [Test Call] ElevenLabs call initiated`);
        console.log(`   Conversation ID: ${callResult.conversation_id}`);
        if (callResult.call_sid) {
          console.log(`   Call SID: ${callResult.call_sid}`);
        }

        await db
          .update(calls)
          .set({ 
            elevenLabsConversationId: callResult.conversation_id,
            twilioSid: callResult.call_sid || null,
            status: 'ringing',
            metadata: {
              initiatedVia: 'elevenlabs_native',
              agentName: agent.name,
              credentialName: credential.name,
              isTestCall: true,
            }
          })
          .where(eq(calls.id, callRecord.id));

        // Trigger call.started webhook event
        try {
          await webhookDeliveryService.triggerEvent(campaign.userId, 'call.started', {
            campaign: { id: campaign.id, name: campaign.name, type: campaign.type },
            contact: { phone: phoneNumber },
            agent: { id: agent.id, name: agent.name },
            call: {
              id: callRecord.id,
              status: 'initiated',
              phoneNumber: phoneNumber,
              startedAt: callRecord.startedAt,
              conversationId: callResult.conversation_id,
              twilioSid: callResult.call_sid,
            }
          }, campaign.id).catch(err => {
            console.error(`Failed to trigger call.started webhook: ${err.message}`);
          });
        } catch (webhookError: any) {
          console.error(`Failed to trigger call.started webhook: ${webhookError.message}`);
        }

        res.json({ 
          success: true, 
          message: "Test call initiated successfully via ElevenLabs",
          callId: callRecord.id,
          conversationId: callResult.conversation_id,
          twilioSid: callResult.call_sid
        });

      } catch (callError: any) {
        console.error(`❌ [Test Call] ElevenLabs call initiation failed:`, callError);
        
        await db
          .update(calls)
          .set({ 
            status: 'failed',
            endedAt: new Date(),
            metadata: { error: `ElevenLabs error: ${callError.message}` }
          })
          .where(eq(calls.id, callRecord.id));
        
        throw new Error(`ElevenLabs call failed: ${callError.message}`);
      }

    } catch (error: any) {
      console.error("Test call error:", error);
      res.status(500).json({ 
        error: "Failed to initiate test call",
        details: error.message 
      });
    }
  });

  return router;
}
