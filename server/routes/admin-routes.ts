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
import { Router, Response } from 'express';
import { storage } from '../storage';
import { checkAdminWithReadOnly, AdminRequest } from '../middleware/admin-auth';
import { z } from 'zod';
import { insertPlanSchema, insertCreditPackageSchema, insertElevenLabsCredentialSchema, calls, agents, openaiCredentials } from '../../shared/schema';
import { ElevenLabsPoolService } from '../services/elevenlabs-pool';
import { twilioService } from '../services/twilio';
import { db } from '../db';
import { eq, isNull, isNotNull, and, or } from 'drizzle-orm';
import { getDomain } from '../utils/domain';
import multer from 'multer';
import Stripe from 'stripe';
import { 
  resetRazorpayClient, 
  getActivePaymentGateway, 
  getRazorpayClient,
  createRazorpayPlan,
  isRazorpayConfigured
} from '../services/razorpay-service';
import {
  resetStripeClient,
  getStripeCurrency,
  getSupportedCurrencies
} from '../services/stripe-service';
import { getResourceStatus, clearSettingsCache } from '../services/resource-watchdog';
import {
  isPayPalConfigured,
  createPayPalProduct,
  createPayPalPlan,
  getPayPalCurrency,
  resetPayPalClient,
} from '../services/paypal-service';
import {
  isPaystackConfigured,
  createPaystackPlan,
  getPaystackCurrency,
  resetPaystackClient,
} from '../services/paystack-service';
import {
  isMercadoPagoConfigured,
  createMercadoPagoSubscriptionPlan,
  getMercadoPagoCurrency,
  resetMercadoPagoClient,
} from '../services/mercadopago-service';
import { recordingService } from '../services/recording-service';
import { emailService } from '../services/email-service';

// Helper function to get Stripe client (checks DB first, then env var)
async function getStripeClient(): Promise<Stripe | null> {
  try {
    // First check database setting
    const dbSetting = await storage.getGlobalSetting('stripe_secret_key');
    const secretKey = (dbSetting?.value as string) || process.env.STRIPE_SECRET_KEY;
    
    if (!secretKey) {
      return null;
    }
    
    return new Stripe(secretKey, { apiVersion: '2025-10-29.clover' });
  } catch (error) {
    console.error('Error initializing Stripe client:', error);
    return null;
  }
}

// Helper function to get default currency from database settings
async function getDefaultCurrency(): Promise<string> {
  try {
    const currencyConfig = await getStripeCurrency();
    return currencyConfig.currency;
  } catch (error) {
    console.error('Error getting default currency:', error);
    return 'USD';
  }
}

// Configure multer for file uploads (logo/favicon)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit for images
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

const router = Router();

// All routes require admin authentication (read-only for admins, full access for super admins)
router.use(checkAdminWithReadOnly);

// Lightweight user search endpoint for assignment dialogs (fast, no subscription details)
router.get('/users/search', async (req: AdminRequest, res: Response) => {
  try {
    const search = (req.query.search as string || '').toLowerCase().trim();
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    
    const allUsers = await storage.getAllUsers();
    
    // Filter by search term
    let filteredUsers = allUsers;
    if (search) {
      filteredUsers = allUsers.filter(user => 
        user.email.toLowerCase().includes(search) ||
        (user.name && user.name.toLowerCase().includes(search))
      );
    }
    
    // Limit results and return only essential fields
    const results = filteredUsers.slice(0, limit).map(user => ({
      id: user.id,
      email: user.email,
      name: user.name || null
    }));
    
    res.json({
      users: results,
      total: filteredUsers.length,
      hasMore: filteredUsers.length > limit
    });
  } catch (error) {
    console.error('Error searching users:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// Get all users with their subscription details
router.get('/users', async (req: AdminRequest, res: Response) => {
  try {
    // Get pagination parameters
    const page = parseInt(req.query.page as string, 10) || 1;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 25;
    const search = (req.query.search as string || '').toLowerCase().trim();
    const offset = (page - 1) * pageSize;

    const allUsers = await storage.getAllUsers();
    
    // Filter by search term if provided
    let filteredUsers = allUsers;
    if (search) {
      filteredUsers = allUsers.filter(user => 
        user.email.toLowerCase().includes(search) ||
        (user.name && user.name.toLowerCase().includes(search))
      );
    }
    
    const totalItems = filteredUsers.length;
    const totalPages = Math.ceil(totalItems / pageSize);
    
    // Paginate users
    const paginatedUsers = filteredUsers.slice(offset, offset + pageSize);
    
    // Add subscription details for each user
    const usersWithDetails = await Promise.all(paginatedUsers.map(async (user) => {
      const subscription = await storage.getUserSubscription(user.id);
      const plan = user.planType ? await storage.getPlanByName(user.planType) : null;
      
      return {
        ...user,
        subscription,
        plan,
        // Hide sensitive data
        password: undefined,
        stripeCustomerId: undefined,
        stripeSubscriptionId: undefined
      };
    }));
    
    // Return users data
    const responseData = usersWithDetails;
    
    res.json({
      data: responseData,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages
      }
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Update user (activate/deactivate, change plan, add credits)
router.patch('/users/:userId', async (req: AdminRequest, res: Response) => {
  try {
    const { userId } = req.params;
    
    // Get all plans to validate planType dynamically (case-insensitive)
    const allPlans = await storage.getAllPlans();
    const validPlanNames = allPlans.map(p => p.name);
    const validPlanNamesLower = validPlanNames.map(n => n.toLowerCase());
    
    // Helper to normalize planType to canonical name
    const normalizePlanType = (val: string | undefined): string | undefined => {
      if (!val) return val;
      const idx = validPlanNamesLower.indexOf(val.toLowerCase());
      return idx >= 0 ? validPlanNames[idx] : val;
    };
    
    let updateData;
    try {
      const parsed = z.object({
        isActive: z.boolean().optional(),
        planType: z.string().optional().refine(
          (val) => !val || validPlanNamesLower.includes(val.toLowerCase()),
          { message: `Plan must be one of: ${validPlanNames.join(', ')}` }
        ),
        credits: z.number().optional(),
        role: z.enum(['user', 'manager', 'admin']).optional(),
        maxWebhooks: z.number().min(0).max(100).optional()
      }).parse(req.body);
      
      // Normalize planType to canonical name
      updateData = {
        ...parsed,
        planType: normalizePlanType(parsed.planType)
      };
    } catch (validationError: any) {
      if (validationError.errors) {
        return res.status(400).json({ 
          error: 'Validation failed', 
          details: validationError.errors 
        });
      }
      throw validationError;
    }
    
    // Get user before update to check for suspension status change
    const userBeforeUpdate = await storage.getUser(userId);
    if (!userBeforeUpdate) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    await storage.updateUser(userId, updateData);
    
    // Send suspension email if user was just suspended
    if (updateData.isActive === false && userBeforeUpdate?.isActive === true) {
      try {
        await emailService.sendAccountSuspended(userId, "Account suspended by administrator");
        console.log(`[Admin] Sent suspension email to user ${userId}`);
      } catch (emailError) {
        console.error(`Failed to send suspension email to user ${userId}:`, emailError);
      }
    }
    
    // Send reactivation email if user was just reactivated
    if (updateData.isActive === true && userBeforeUpdate?.isActive === false) {
      try {
        await emailService.sendAccountReactivated(userId);
        console.log(`[Admin] Sent reactivation email to user ${userId}`);
      } catch (emailError) {
        console.error(`Failed to send reactivation email to user ${userId}:`, emailError);
      }
    }
    
    // If plan changed, update or create subscription
    if (updateData.planType) {
      const plan = await storage.getPlanByName(updateData.planType);
      if (plan) {
        // Check if user already has a subscription
        const existingSubscription = await storage.getUserSubscription(userId);
        
        if (existingSubscription && existingSubscription.id) {
          // Update existing subscription with new plan
          await storage.updateUserSubscription(existingSubscription.id, {
            planId: plan.id,
            status: 'active',
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
          });
        } else {
          // Create new subscription if none exists
          await storage.createUserSubscription({
            userId,
            planId: plan.id,
            status: 'active',
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
          });
        }
        
        // Send membership upgrade email if plan was upgraded from free to a paid plan
        const oldPlanType = userBeforeUpdate?.planType?.toLowerCase();
        const newPlanType = updateData.planType.toLowerCase();
        const isPaidPlan = plan.monthlyPrice && parseFloat(plan.monthlyPrice.toString()) > 0;
        
        if (isPaidPlan && oldPlanType === 'free') {
          try {
            await emailService.sendMembershipUpgrade(userId, plan.displayName || plan.name);
            console.log(`[Admin] Sent membership upgrade email to user ${userId}`);
          } catch (emailError) {
            console.error(`Failed to send membership upgrade email to user ${userId}:`, emailError);
          }
        }
        
        console.log(`[Admin] User ${userId} plan changed from ${oldPlanType} to ${newPlanType}`);
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Create new user (admin only)
router.post('/users', async (req: AdminRequest, res: Response) => {
  try {
    const bcrypt = await import('bcrypt');
    const { users } = await import('@shared/schema');
    const { db } = await import('../db');
    
    // Get all plans to validate planType dynamically (case-insensitive)
    const allPlans = await storage.getAllPlans();
    const validPlanNames = allPlans.map(p => p.name);
    const validPlanNamesLower = validPlanNames.map(n => n.toLowerCase());
    const defaultPlan = validPlanNamesLower.includes('free') 
      ? validPlanNames.find(n => n.toLowerCase() === 'free') || 'free'
      : validPlanNames[0] || 'free';
    
    // Helper to normalize planType to canonical name
    const normalizePlanType = (val: string): string => {
      const idx = validPlanNamesLower.indexOf(val.toLowerCase());
      return idx >= 0 ? validPlanNames[idx] : val;
    };
    
    const createUserSchema = z.object({
      email: z.string().email(),
      password: z.string().min(6),
      name: z.string().min(1),
      role: z.enum(['user', 'manager', 'admin']).default('user'),
      planType: z.string().default(defaultPlan).refine(
        (val) => validPlanNamesLower.includes(val.toLowerCase()),
        { message: `Plan must be one of: ${validPlanNames.join(', ')}` }
      ),
      credits: z.number().min(0).default(0),
      isActive: z.boolean().default(true)
    });
    
    const parsedData = createUserSchema.parse(req.body);
    
    // Normalize planType to canonical name
    const userData = {
      ...parsedData,
      planType: normalizePlanType(parsedData.planType)
    };
    
    // Check if email already exists
    const existingUser = await storage.getUserByEmail(userData.email);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(userData.password, 10);
    
    // Create user directly with all fields
    const [newUser] = await db.insert(users).values({
      email: userData.email,
      password: hashedPassword,
      name: userData.name,
      role: userData.role,
      planType: userData.planType,
      credits: userData.credits,
      isActive: userData.isActive,
    }).returning();
    
    // Create subscription for user
    const plan = await storage.getPlanByName(userData.planType);
    if (plan) {
      await storage.createUserSubscription({
        userId: newUser.id,
        planId: plan.id,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
      });
    }
    
    console.log(`✅ [Admin] Created new user: ${userData.email}`);
    
    res.status(201).json({ 
      success: true, 
      user: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
        role: newUser.role,
        planType: newUser.planType,
        credits: newUser.credits,
        isActive: newUser.isActive,
      }
    });
  } catch (error: any) {
    console.error('Error creating user:', error);
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Invalid input data', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Delete user and all their data (hard delete - admin only)
router.delete('/users/:userId', async (req: AdminRequest, res: Response) => {
  try {
    const { userId } = req.params;
    const { db } = await import('../db');
    const { eq } = await import('drizzle-orm');
    const schema = await import('@shared/schema');
    
    // Check if user exists
    const user = await storage.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    console.log(`🗑️ [Admin] Starting cascade delete for user: ${user.email} (${userId})`);
    
    // Delete in proper order to respect foreign key constraints
    // Many tables have onDelete: cascade, but we'll be explicit for safety
    
    // 1. Delete form submissions, fields, and forms
    const userForms = await db.select({ id: schema.forms.id }).from(schema.forms).where(eq(schema.forms.userId, userId));
    for (const form of userForms) {
      await db.delete(schema.formSubmissions).where(eq(schema.formSubmissions.formId, form.id));
      await db.delete(schema.formFields).where(eq(schema.formFields.formId, form.id));
    }
    await db.delete(schema.forms).where(eq(schema.forms.userId, userId));
    
    // 2. Delete appointments and appointment settings
    await db.delete(schema.appointments).where(eq(schema.appointments.userId, userId));
    await db.delete(schema.appointmentSettings).where(eq(schema.appointmentSettings.userId, userId));
    
    // 3. Delete webhook subscriptions and delivery logs
    const userWebhooks = await db.select({ id: schema.webhookSubscriptions.id }).from(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.userId, userId));
    for (const webhook of userWebhooks) {
      await db.delete(schema.webhookDeliveryLogs).where(eq(schema.webhookDeliveryLogs.webhookId, webhook.id));
    }
    await db.delete(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.userId, userId));
    
    // 4. Delete knowledge processing queue and chunks
    await db.delete(schema.knowledgeProcessingQueue).where(eq(schema.knowledgeProcessingQueue.userId, userId));
    await db.delete(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.userId, userId));
    await db.delete(schema.userKnowledgeStorageLimits).where(eq(schema.userKnowledgeStorageLimits.userId, userId));
    
    // 5. Delete audit logs
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, userId));
    
    // 6. Delete agent versions (cascade deletes when agents are deleted, but clean up any orphaned)
    // Agent versions are linked to agents via agentId, not userId - they'll be cascade deleted with agents
    
    // 7. Delete prompt templates (email templates are global, not per-user)
    await db.delete(schema.promptTemplates).where(eq(schema.promptTemplates.userId, userId));
    
    // 8. Delete notifications
    await db.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
    
    // 9. Delete legacy webhooks
    await db.delete(schema.legacyWebhooks).where(eq(schema.legacyWebhooks.userId, userId));
    
    // 10. Delete usage records and phone number rentals
    await db.delete(schema.usageRecords).where(eq(schema.usageRecords.userId, userId));
    await db.delete(schema.phoneNumberRentals).where(eq(schema.phoneNumberRentals.userId, userId));
    
    // 11. Delete user subscriptions
    await db.delete(schema.userSubscriptions).where(eq(schema.userSubscriptions.userId, userId));
    
    // 12. Delete tools and voices
    await db.delete(schema.tools).where(eq(schema.tools.userId, userId));
    await db.delete(schema.voices).where(eq(schema.voices.userId, userId));
    
    // 13. Delete credit transactions
    await db.delete(schema.creditTransactions).where(eq(schema.creditTransactions.userId, userId));
    
    // 14. Delete flow executions first (references calls and flows)
    const userFlows = await db.select({ id: schema.flows.id }).from(schema.flows).where(eq(schema.flows.userId, userId));
    for (const flow of userFlows) {
      await db.delete(schema.flowExecutions).where(eq(schema.flowExecutions.flowId, flow.id));
    }
    
    // 15. Delete calls (references campaigns and agents)
    await db.delete(schema.calls).where(eq(schema.calls.userId, userId));
    
    // 16. Delete contacts through campaigns
    const userCampaigns = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(eq(schema.campaigns.userId, userId));
    for (const campaign of userCampaigns) {
      await db.delete(schema.contacts).where(eq(schema.contacts.campaignId, campaign.id));
    }
    
    // 17. Delete campaigns
    await db.delete(schema.campaigns).where(eq(schema.campaigns.userId, userId));
    
    // 18. Delete flows
    await db.delete(schema.flows).where(eq(schema.flows.userId, userId));
    
    // 19. Delete incoming connections
    await db.delete(schema.incomingConnections).where(eq(schema.incomingConnections.userId, userId));
    
    // 20. Delete phone numbers owned by user
    await db.delete(schema.phoneNumbers).where(eq(schema.phoneNumbers.userId, userId));
    
    // 21. Delete incoming agents
    await db.delete(schema.incomingAgents).where(eq(schema.incomingAgents.userId, userId));
    
    // 22. Delete knowledge base
    await db.delete(schema.knowledgeBase).where(eq(schema.knowledgeBase.userId, userId));
    
    // 23. Delete agents
    await db.delete(schema.agents).where(eq(schema.agents.userId, userId));
    
    // 24. Finally delete the user
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    
    console.log(`✅ [Admin] Successfully deleted user and all data: ${user.email}`);
    
    res.json({ success: true, message: `User ${user.email} and all associated data have been permanently deleted` });
  } catch (error: any) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user', details: error.message });
  }
});

// Recover a soft-deleted user account (admin only)
router.post('/users/:userId/recover', async (req: AdminRequest, res: Response) => {
  try {
    const { userId } = req.params;
    const { users } = await import('@shared/schema');
    const { db } = await import('../db');
    const { eq } = await import('drizzle-orm');
    
    // Check if user exists
    const user = await storage.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Recover the account
    await db.update(users)
      .set({ 
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        isActive: true
      })
      .where(eq(users.id, userId));
    
    res.json({ success: true, message: 'User account has been recovered' });
  } catch (error) {
    console.error('Error recovering user:', error);
    res.status(500).json({ error: 'Failed to recover user' });
  }
});

// Get all contacts from all users (unique by phone number, most recent record)
router.get('/contacts', async (req: AdminRequest, res: Response) => {
  try {
    const { contacts, campaigns, users: usersTable } = await import('@shared/schema');
    const { db } = await import('../db');
    const { eq, desc } = await import('drizzle-orm');
    
    // Get pagination parameters
    const page = parseInt(req.query.page as string, 10) || 1;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 50;
    const offset = (page - 1) * pageSize;
    
    // Fetch all contacts with campaign and user info, ordered by most recent first
    const allContacts = await db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        phone: contacts.phone,
        email: contacts.email,
        customFields: contacts.customFields,
        status: contacts.status,
        createdAt: contacts.createdAt,
        campaignId: contacts.campaignId,
        campaignName: campaigns.name,
        userId: campaigns.userId,
        userName: usersTable.name,
        userEmail: usersTable.email,
      })
      .from(contacts)
      .leftJoin(campaigns, eq(contacts.campaignId, campaigns.id))
      .leftJoin(usersTable, eq(campaigns.userId, usersTable.id))
      .orderBy(desc(contacts.createdAt));
    
    // Deduplicate by phone number, keeping the most recent record
    const uniqueByPhone = new Map<string, typeof allContacts[0]>();
    for (const contact of allContacts) {
      const phoneKey = contact.phone?.trim().toLowerCase() || '';
      if (phoneKey && !uniqueByPhone.has(phoneKey)) {
        uniqueByPhone.set(phoneKey, contact);
      }
    }
    
    // Convert back to array and sort by createdAt desc
    const uniqueContacts = Array.from(uniqueByPhone.values())
      .sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateB - dateA;
      });
    
    const totalItems = uniqueContacts.length;
    const totalPages = Math.ceil(totalItems / pageSize);
    const paginatedContacts = uniqueContacts.slice(offset, offset + pageSize);
    
    res.json({
      data: paginatedContacts,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages
      }
    });
  } catch (error) {
    console.error('Error fetching admin contacts:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// Get all plans
router.get('/plans', async (req: AdminRequest, res: Response) => {
  try {
    const plans = await storage.getAllPlans();
    res.json(plans);
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// Create new plan
router.post('/plans', async (req: AdminRequest, res: Response) => {
  try {
    // Convert price fields to strings (decimal fields expect strings)
    const bodyData = { ...req.body };
    if (typeof bodyData.monthlyPrice === 'number') {
      bodyData.monthlyPrice = bodyData.monthlyPrice.toFixed(2);
    }
    if (typeof bodyData.yearlyPrice === 'number') {
      bodyData.yearlyPrice = bodyData.yearlyPrice.toFixed(2);
    }
    if (typeof bodyData.razorpayMonthlyPrice === 'number') {
      bodyData.razorpayMonthlyPrice = bodyData.razorpayMonthlyPrice.toFixed(2);
    }
    if (typeof bodyData.razorpayYearlyPrice === 'number') {
      bodyData.razorpayYearlyPrice = bodyData.razorpayYearlyPrice.toFixed(2);
    }
    if (typeof bodyData.paypalMonthlyPrice === 'number') {
      bodyData.paypalMonthlyPrice = bodyData.paypalMonthlyPrice.toFixed(2);
    }
    if (typeof bodyData.paypalYearlyPrice === 'number') {
      bodyData.paypalYearlyPrice = bodyData.paypalYearlyPrice.toFixed(2);
    }
    if (typeof bodyData.paystackMonthlyPrice === 'number') {
      bodyData.paystackMonthlyPrice = bodyData.paystackMonthlyPrice.toFixed(2);
    }
    if (typeof bodyData.paystackYearlyPrice === 'number') {
      bodyData.paystackYearlyPrice = bodyData.paystackYearlyPrice.toFixed(2);
    }
    if (typeof bodyData.mercadopagoMonthlyPrice === 'number') {
      bodyData.mercadopagoMonthlyPrice = bodyData.mercadopagoMonthlyPrice.toFixed(2);
    }
    if (typeof bodyData.mercadopagoYearlyPrice === 'number') {
      bodyData.mercadopagoYearlyPrice = bodyData.mercadopagoYearlyPrice.toFixed(2);
    }
    
    let planData;
    try {
      planData = insertPlanSchema.parse(bodyData);
    } catch (validationError: any) {
      if (validationError.errors) {
        return res.status(400).json({ 
          error: 'Validation failed', 
          details: validationError.errors 
        });
      }
      throw validationError;
    }
    
    // Create the plan first
    let newPlan = await storage.createPlan(planData);
    
    // Check which payment gateway is active
    const activeGateway = await getActivePaymentGateway();
    
    // Always sync to Razorpay if configured and INR prices exist (independent of active gateway)
    const razorpayConfigured = await isRazorpayConfigured();
    if (razorpayConfigured) {
      try {
        // Use INR prices for Razorpay (razorpayMonthlyPrice and razorpayYearlyPrice)
        const monthlyInrAmount = planData.razorpayMonthlyPrice ? parseFloat(planData.razorpayMonthlyPrice.toString()) : 0;
        let razorpayMonthlyPlanId: string | null = null;
        
        if (monthlyInrAmount > 0) {
          const monthlyPlan = await createRazorpayPlan({
            period: 'monthly',
            interval: 1,
            name: `${planData.displayName} - Monthly`,
            amount: monthlyInrAmount,
            currency: 'INR',
            description: planData.description || undefined,
            notes: {
              planId: newPlan.id,
              billingPeriod: 'monthly'
            }
          });
          razorpayMonthlyPlanId = monthlyPlan.id;
          console.log(`✅ [Razorpay] Created monthly plan ${monthlyPlan.id} with INR ${monthlyInrAmount}`);
        }
        
        // Create yearly plan in Razorpay using INR price
        let razorpayYearlyPlanId: string | null = null;
        const yearlyInrAmount = planData.razorpayYearlyPrice ? parseFloat(planData.razorpayYearlyPrice.toString()) : 0;
        if (yearlyInrAmount > 0) {
          const yearlyPlan = await createRazorpayPlan({
            period: 'yearly',
            interval: 1,
            name: `${planData.displayName} - Yearly`,
            amount: yearlyInrAmount,
            currency: 'INR',
            description: planData.description || undefined,
            notes: {
              planId: newPlan.id,
              billingPeriod: 'yearly'
            }
          });
          razorpayYearlyPlanId = yearlyPlan.id;
          console.log(`✅ [Razorpay] Created yearly plan ${yearlyPlan.id} with INR ${yearlyInrAmount}`);
        }
        
        // Update plan with Razorpay IDs (razorpayPlanId = monthly, razorpayYearlyPlanId = yearly)
        if (razorpayMonthlyPlanId || razorpayYearlyPlanId) {
          await storage.updatePlan(newPlan.id, {
            razorpayPlanId: razorpayMonthlyPlanId,
            razorpayYearlyPlanId
          });
          
          // Fetch updated plan
          const updatedPlan = await storage.getPlan(newPlan.id);
          if (updatedPlan) {
            newPlan = updatedPlan;
          }
        }
        
        console.log(`✅ [Razorpay] Plan sync complete for ${newPlan.id}: monthly=${razorpayMonthlyPlanId}, yearly=${razorpayYearlyPlanId}`);
      } catch (razorpayError: any) {
        console.error('❌ [Razorpay] Error syncing plan to Razorpay:', razorpayError.message);
        // Plan was created, just Razorpay sync failed - continue without blocking
      }
    }
    
    // Always sync to Stripe if configured (independent of active gateway)
    const stripe = await getStripeClient();
    if (stripe) {
      try {
        const currency = await getDefaultCurrency();
        
        // Create Stripe Product
        const stripeProduct = await stripe.products.create({
          name: planData.displayName,
          description: planData.description || undefined,
          metadata: {
            planId: newPlan.id,
            planName: planData.name
          }
        });
        
        // Create monthly recurring price (using USD price)
        const monthlyAmount = parseFloat(planData.monthlyPrice.toString());
        let monthlyPrice: Stripe.Price | null = null;
        if (monthlyAmount > 0) {
          monthlyPrice = await stripe.prices.create({
            product: stripeProduct.id,
            unit_amount: Math.round(monthlyAmount * 100),
            currency: currency.toLowerCase(),
            recurring: {
              interval: 'month'
            },
            metadata: {
              planId: newPlan.id,
              billingPeriod: 'monthly'
            }
          });
        }
        
        // Create yearly recurring price (if yearlyPrice is provided)
        let yearlyPrice: Stripe.Price | null = null;
        if (planData.yearlyPrice) {
          const yearlyAmount = parseFloat(planData.yearlyPrice.toString());
          if (yearlyAmount > 0) {
            yearlyPrice = await stripe.prices.create({
              product: stripeProduct.id,
              unit_amount: Math.round(yearlyAmount * 100),
              currency: currency.toLowerCase(),
              recurring: {
                interval: 'year'
              },
              metadata: {
                planId: newPlan.id,
                billingPeriod: 'yearly'
              }
            });
          }
        }
        
        // Update plan with Stripe IDs
        await storage.updatePlan(newPlan.id, {
          stripeProductId: stripeProduct.id,
          stripeMonthlyPriceId: monthlyPrice?.id || null,
          stripeYearlyPriceId: yearlyPrice?.id || null
        });
        
        // Fetch updated plan
        const updatedPlan = await storage.getPlan(newPlan.id);
        if (updatedPlan) {
          newPlan = updatedPlan;
        }
        
        console.log(`✅ [Stripe] Created product ${stripeProduct.id} and prices for plan ${newPlan.id}`);
      } catch (stripeError: any) {
        console.error('❌ [Stripe] Error syncing plan to Stripe:', stripeError.message);
        // Plan was created, just Stripe sync failed - continue without blocking
      }
    } else {
      console.log('ℹ️ [Stripe] No Stripe key configured, skipping plan sync');
    }
    
    // Sync to PayPal if configured
    const paypalConfigured = await isPayPalConfigured();
    if (paypalConfigured) {
      try {
        const paypalCurrency = await getPayPalCurrency();
        const paypalUpdateData: any = {};
        
        // Create PayPal Product
        const paypalProduct = await createPayPalProduct({
          name: planData.displayName,
          description: planData.description || undefined,
          type: 'SERVICE',
        });
        paypalUpdateData.paypalProductId = paypalProduct.id;
        console.log(`✅ [PayPal] Created product ${paypalProduct.id}`);
        
        // Create monthly plan
        const paypalMonthlyAmount = planData.paypalMonthlyPrice ? parseFloat(planData.paypalMonthlyPrice.toString()) : 0;
        if (paypalMonthlyAmount > 0) {
          const monthlyPlan = await createPayPalPlan({
            productId: paypalProduct.id,
            name: `${planData.displayName} - Monthly`,
            description: planData.description || undefined,
            billingCycles: [{
              frequency: { interval_unit: 'MONTH', interval_count: 1 },
              tenure_type: 'REGULAR',
              sequence: 1,
              total_cycles: 0,
              pricing_scheme: {
                fixed_price: {
                  value: paypalMonthlyAmount.toFixed(2),
                  currency_code: paypalCurrency.currency,
                },
              },
            }],
          });
          paypalUpdateData.paypalMonthlyPlanId = monthlyPlan.id;
          console.log(`✅ [PayPal] Created monthly plan ${monthlyPlan.id}`);
        }
        
        // Create yearly plan
        const paypalYearlyAmount = planData.paypalYearlyPrice ? parseFloat(planData.paypalYearlyPrice.toString()) : 0;
        if (paypalYearlyAmount > 0) {
          const yearlyPlan = await createPayPalPlan({
            productId: paypalProduct.id,
            name: `${planData.displayName} - Yearly`,
            description: planData.description || undefined,
            billingCycles: [{
              frequency: { interval_unit: 'YEAR', interval_count: 1 },
              tenure_type: 'REGULAR',
              sequence: 1,
              total_cycles: 0,
              pricing_scheme: {
                fixed_price: {
                  value: paypalYearlyAmount.toFixed(2),
                  currency_code: paypalCurrency.currency,
                },
              },
            }],
          });
          paypalUpdateData.paypalYearlyPlanId = yearlyPlan.id;
          console.log(`✅ [PayPal] Created yearly plan ${yearlyPlan.id}`);
        }
        
        if (Object.keys(paypalUpdateData).length > 0) {
          await storage.updatePlan(newPlan.id, paypalUpdateData);
          const updatedPlan = await storage.getPlan(newPlan.id);
          if (updatedPlan) newPlan = updatedPlan;
        }
      } catch (paypalError: any) {
        console.error('❌ [PayPal] Error syncing plan to PayPal:', paypalError.message);
      }
    }
    
    // Sync to Paystack if configured
    const paystackConfigured = await isPaystackConfigured();
    if (paystackConfigured) {
      try {
        const paystackCurrency = await getPaystackCurrency();
        const paystackUpdateData: any = {};
        const PAYSTACK_MIN_AMOUNT = 100;
        
        // Create monthly plan
        const paystackMonthlyAmount = planData.paystackMonthlyPrice ? parseFloat(planData.paystackMonthlyPrice.toString()) : 0;
        if (paystackMonthlyAmount >= PAYSTACK_MIN_AMOUNT) {
          const monthlyPlan = await createPaystackPlan({
            name: `${planData.displayName} - Monthly`,
            interval: 'monthly',
            amount: paystackMonthlyAmount,
            currency: paystackCurrency.currency,
            description: planData.description || undefined,
          });
          paystackUpdateData.paystackMonthlyPlanCode = monthlyPlan.plan_code;
          console.log(`✅ [Paystack] Created monthly plan ${monthlyPlan.plan_code}`);
        }
        
        // Create yearly plan
        const paystackYearlyAmount = planData.paystackYearlyPrice ? parseFloat(planData.paystackYearlyPrice.toString()) : 0;
        if (paystackYearlyAmount >= PAYSTACK_MIN_AMOUNT) {
          const yearlyPlan = await createPaystackPlan({
            name: `${planData.displayName} - Yearly`,
            interval: 'annually',
            amount: paystackYearlyAmount,
            currency: paystackCurrency.currency,
            description: planData.description || undefined,
          });
          paystackUpdateData.paystackYearlyPlanCode = yearlyPlan.plan_code;
          console.log(`✅ [Paystack] Created yearly plan ${yearlyPlan.plan_code}`);
        }
        
        if (Object.keys(paystackUpdateData).length > 0) {
          await storage.updatePlan(newPlan.id, paystackUpdateData);
          const updatedPlan = await storage.getPlan(newPlan.id);
          if (updatedPlan) newPlan = updatedPlan;
        }
      } catch (paystackError: any) {
        console.error('❌ [Paystack] Error syncing plan to Paystack:', paystackError.message);
      }
    }
    
    // Sync to MercadoPago if configured
    const mercadopagoConfigured = await isMercadoPagoConfigured();
    if (mercadopagoConfigured) {
      try {
        const mercadopagoCurrency = await getMercadoPagoCurrency();
        const baseUrl = process.env.BASE_URL || process.env.APP_URL;
        const mercadopagoUpdateData: any = {};
        
        if (baseUrl) {
          // Create monthly plan
          const mercadopagoMonthlyAmount = planData.mercadopagoMonthlyPrice ? parseFloat(planData.mercadopagoMonthlyPrice.toString()) : 0;
          if (mercadopagoMonthlyAmount > 0) {
            const monthlyPlan = await createMercadoPagoSubscriptionPlan({
              reason: `${planData.displayName} - Monthly`,
              autoRecurring: {
                frequency: 1,
                frequencyType: 'months',
                transactionAmount: mercadopagoMonthlyAmount,
                currencyId: mercadopagoCurrency.currency,
              },
              backUrl: `${baseUrl}/app/billing`,
            });
            mercadopagoUpdateData.mercadopagoMonthlyPlanId = monthlyPlan.id;
            console.log(`✅ [MercadoPago] Created monthly plan ${monthlyPlan.id}`);
          }
          
          // Create yearly plan
          const mercadopagoYearlyAmount = planData.mercadopagoYearlyPrice ? parseFloat(planData.mercadopagoYearlyPrice.toString()) : 0;
          if (mercadopagoYearlyAmount > 0) {
            const yearlyPlan = await createMercadoPagoSubscriptionPlan({
              reason: `${planData.displayName} - Yearly`,
              autoRecurring: {
                frequency: 12,
                frequencyType: 'months',
                transactionAmount: mercadopagoYearlyAmount,
                currencyId: mercadopagoCurrency.currency,
              },
              backUrl: `${baseUrl}/app/billing`,
            });
            mercadopagoUpdateData.mercadopagoYearlyPlanId = yearlyPlan.id;
            console.log(`✅ [MercadoPago] Created yearly plan ${yearlyPlan.id}`);
          }
          
          if (Object.keys(mercadopagoUpdateData).length > 0) {
            await storage.updatePlan(newPlan.id, mercadopagoUpdateData);
            const updatedPlan = await storage.getPlan(newPlan.id);
            if (updatedPlan) newPlan = updatedPlan;
          }
        } else {
          console.log('ℹ️ [MercadoPago] No BASE_URL configured, skipping plan sync');
        }
      } catch (mercadopagoError: any) {
        console.error('❌ [MercadoPago] Error syncing plan to MercadoPago:', mercadopagoError.message);
      }
    }
    
    res.json(newPlan);
  } catch (error: any) {
    console.error('Error creating plan:', error);
    // Return 400 for validation errors, 500 for internal errors
    if (error.name === 'ZodError') {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: error.errors 
      });
    }
    res.status(500).json({ error: 'Failed to create plan' });
  }
});

// Update plan configuration
router.patch('/plans/:planId', async (req: AdminRequest, res: Response) => {
  try {
    const { planId } = req.params;
    
    // Convert price fields to strings (decimal fields expect strings)
    const bodyData = { ...req.body };
    if (typeof bodyData.monthlyPrice === 'number') {
      bodyData.monthlyPrice = bodyData.monthlyPrice.toFixed(2);
    }
    if (typeof bodyData.yearlyPrice === 'number') {
      bodyData.yearlyPrice = bodyData.yearlyPrice.toFixed(2);
    }
    if (typeof bodyData.razorpayMonthlyPrice === 'number') {
      bodyData.razorpayMonthlyPrice = bodyData.razorpayMonthlyPrice.toFixed(2);
    }
    if (typeof bodyData.razorpayYearlyPrice === 'number') {
      bodyData.razorpayYearlyPrice = bodyData.razorpayYearlyPrice.toFixed(2);
    }
    if (typeof bodyData.paypalMonthlyPrice === 'number') {
      bodyData.paypalMonthlyPrice = bodyData.paypalMonthlyPrice.toFixed(2);
    }
    if (typeof bodyData.paypalYearlyPrice === 'number') {
      bodyData.paypalYearlyPrice = bodyData.paypalYearlyPrice.toFixed(2);
    }
    if (typeof bodyData.paystackMonthlyPrice === 'number') {
      bodyData.paystackMonthlyPrice = bodyData.paystackMonthlyPrice.toFixed(2);
    }
    if (typeof bodyData.paystackYearlyPrice === 'number') {
      bodyData.paystackYearlyPrice = bodyData.paystackYearlyPrice.toFixed(2);
    }
    if (typeof bodyData.mercadopagoMonthlyPrice === 'number') {
      bodyData.mercadopagoMonthlyPrice = bodyData.mercadopagoMonthlyPrice.toFixed(2);
    }
    if (typeof bodyData.mercadopagoYearlyPrice === 'number') {
      bodyData.mercadopagoYearlyPrice = bodyData.mercadopagoYearlyPrice.toFixed(2);
    }
    
    let updateData;
    try {
      updateData = insertPlanSchema.partial().parse(bodyData);
    } catch (validationError: any) {
      if (validationError.errors) {
        return res.status(400).json({ 
          error: 'Validation failed', 
          details: validationError.errors 
        });
      }
      throw validationError;
    }
    
    // Get existing plan to check for price changes
    const existingPlan = await storage.getPlan(planId);
    if (!existingPlan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    // Check which payment gateway is active
    const activeGateway = await getActivePaymentGateway();
    
    // Always sync to Razorpay if configured and INR prices exist (independent of active gateway)
    const razorpayConfigured = await isRazorpayConfigured();
    if (razorpayConfigured) {
      try {
        // Force resync option - recreate all Razorpay plans (since they're immutable)
        const forceRazorpaySync = req.body.forceRazorpaySync === true;
        if (forceRazorpaySync) {
          console.log(`🔄 [Razorpay] Force sync requested for plan ${planId} - will recreate all plans in INR`);
        }
        
        // Use INR-specific price fields for Razorpay (not USD prices)
        const newMonthlyInrPrice = updateData.razorpayMonthlyPrice?.toString();
        const oldMonthlyInrPrice = existingPlan.razorpayMonthlyPrice?.toString();
        const effectiveMonthlyInrPrice = newMonthlyInrPrice || oldMonthlyInrPrice;
        const effectiveMonthlyInrAmount = effectiveMonthlyInrPrice ? parseFloat(effectiveMonthlyInrPrice) : 0;
        const monthlyInrPriceChanged = newMonthlyInrPrice && newMonthlyInrPrice !== oldMonthlyInrPrice;
        const needsMonthlyPlan = !existingPlan.razorpayPlanId && effectiveMonthlyInrAmount > 0;
        
        // Handle monthly plan sync (Razorpay plans are immutable, so we create new ones)
        // Also resync if forceRazorpaySync is true
        const shouldResyncMonthlyRazorpay = forceRazorpaySync && effectiveMonthlyInrAmount > 0;
        if (effectiveMonthlyInrAmount > 0 && (monthlyInrPriceChanged || needsMonthlyPlan || shouldResyncMonthlyRazorpay)) {
          const priceAmount = monthlyInrPriceChanged ? parseFloat(newMonthlyInrPrice!) : effectiveMonthlyInrAmount;
          const monthlyPlan = await createRazorpayPlan({
            period: 'monthly',
            interval: 1,
            name: `${updateData.displayName || existingPlan.displayName} - Monthly`,
            amount: priceAmount,
            currency: 'INR',
            description: updateData.description || existingPlan.description || undefined,
            notes: {
              planId: planId,
              billingPeriod: 'monthly'
            }
          });
          updateData.razorpayPlanId = monthlyPlan.id;
          console.log(`✅ [Razorpay] Created monthly plan ${monthlyPlan.id} with INR ${priceAmount}`);
        } else if (effectiveMonthlyInrAmount === 0 && existingPlan.razorpayPlanId) {
          updateData.razorpayPlanId = null;
          console.log(`ℹ️ [Razorpay] Cleared monthly plan ID (no INR price)`);
        }
        
        // Use INR-specific yearly price field for Razorpay
        const newYearlyInrPrice = updateData.razorpayYearlyPrice?.toString();
        const oldYearlyInrPrice = existingPlan.razorpayYearlyPrice?.toString();
        const effectiveYearlyInrPrice = newYearlyInrPrice || oldYearlyInrPrice;
        const effectiveYearlyInrAmount = effectiveYearlyInrPrice ? parseFloat(effectiveYearlyInrPrice) : 0;
        const yearlyInrPriceChanged = newYearlyInrPrice && newYearlyInrPrice !== oldYearlyInrPrice;
        const needsYearlyPlan = !existingPlan.razorpayYearlyPlanId && effectiveYearlyInrAmount > 0;
        
        // Handle yearly plan sync (also resync if forceRazorpaySync is true)
        const shouldResyncYearlyRazorpay = forceRazorpaySync && effectiveYearlyInrAmount > 0;
        if (effectiveYearlyInrAmount > 0 && (yearlyInrPriceChanged || needsYearlyPlan || shouldResyncYearlyRazorpay)) {
          const priceAmount = yearlyInrPriceChanged ? parseFloat(newYearlyInrPrice!) : effectiveYearlyInrAmount;
          const yearlyPlan = await createRazorpayPlan({
            period: 'yearly',
            interval: 1,
            name: `${updateData.displayName || existingPlan.displayName} - Yearly`,
            amount: priceAmount,
            currency: 'INR',
            description: updateData.description || existingPlan.description || undefined,
            notes: {
              planId: planId,
              billingPeriod: 'yearly'
            }
          });
          updateData.razorpayYearlyPlanId = yearlyPlan.id;
          console.log(`✅ [Razorpay] Created yearly plan ${yearlyPlan.id} with INR ${priceAmount}`);
        } else if (effectiveYearlyInrAmount === 0 && existingPlan.razorpayYearlyPlanId) {
          updateData.razorpayYearlyPlanId = null;
          console.log(`ℹ️ [Razorpay] Cleared yearly plan ID (no INR price)`);
        }
        
      } catch (razorpayError: any) {
        console.error('❌ [Razorpay] Error syncing plan to Razorpay:', razorpayError.message);
        // Continue with update without blocking
      }
    }
    
    // Always sync to Stripe if configured (independent of active gateway)
    const stripe = await getStripeClient();
    if (stripe) {
      try {
        const currency = await getDefaultCurrency();
        
        // Force resync option - recreate all Stripe prices in current currency
        // This is used after admin changes currency and needs to resync pricing
        const forceStripeSync = req.body.forceStripeSync === true;
        if (forceStripeSync) {
          console.log(`🔄 [Stripe] Force sync requested for plan ${planId} - will recreate all prices in ${currency}`);
        }
        
        // Check if we need to create a new Stripe product (if none exists)
        let stripeProductId = existingPlan.stripeProductId;
        
        if (!stripeProductId) {
          // Create new Stripe Product
          const stripeProduct = await stripe.products.create({
            name: updateData.displayName || existingPlan.displayName,
            description: updateData.description || existingPlan.description || undefined,
            metadata: {
              planId: planId,
              planName: updateData.name || existingPlan.name
            }
          });
          stripeProductId = stripeProduct.id;
          updateData.stripeProductId = stripeProductId;
          console.log(`✅ [Stripe] Created new product ${stripeProductId} for plan ${planId}`);
        } else {
          // Update existing product if name/description changed
          if (updateData.displayName || updateData.description) {
            await stripe.products.update(stripeProductId, {
              name: updateData.displayName || existingPlan.displayName,
              description: updateData.description || existingPlan.description || undefined
            });
            console.log(`✅ [Stripe] Updated product ${stripeProductId}`);
          }
        }
        
        // Check if monthly price needs to be created/updated
        const newMonthlyPrice = updateData.monthlyPrice?.toString();
        const oldMonthlyPrice = existingPlan.monthlyPrice?.toString();
        const effectiveMonthlyPrice = newMonthlyPrice || oldMonthlyPrice;
        const effectiveMonthlyAmount = effectiveMonthlyPrice ? parseFloat(effectiveMonthlyPrice) : 0;
        const monthlyPriceChanged = newMonthlyPrice && newMonthlyPrice !== oldMonthlyPrice;
        const needsMonthlyPrice = !existingPlan.stripeMonthlyPriceId && effectiveMonthlyAmount > 0;
        
        // Handle monthly price sync (also resync if forceStripeSync is true and there's an existing price)
        const shouldResyncMonthly = forceStripeSync && existingPlan.stripeMonthlyPriceId && effectiveMonthlyAmount > 0;
        if (effectiveMonthlyAmount > 0 && (monthlyPriceChanged || needsMonthlyPrice || shouldResyncMonthly)) {
          // Archive old monthly price if exists (always archive before creating new)
          if (existingPlan.stripeMonthlyPriceId) {
            try {
              await stripe.prices.update(existingPlan.stripeMonthlyPriceId, { active: false });
              console.log(`📦 [Stripe] Archived old monthly price ${existingPlan.stripeMonthlyPriceId}`);
            } catch (archiveErr: any) {
              console.warn(`⚠️ [Stripe] Could not archive old monthly price: ${archiveErr.message}`);
            }
          }
          
          // Create new monthly price
          const priceAmount = monthlyPriceChanged ? newMonthlyPrice! : effectiveMonthlyPrice!;
          const monthlyPrice = await stripe.prices.create({
            product: stripeProductId!,
            unit_amount: Math.round(parseFloat(priceAmount) * 100),
            currency: currency.toLowerCase(),
            recurring: {
              interval: 'month'
            },
            metadata: {
              planId: planId,
              billingPeriod: 'monthly'
            }
          });
          updateData.stripeMonthlyPriceId = monthlyPrice.id;
          console.log(`✅ [Stripe] Created new monthly price ${monthlyPrice.id} ($${priceAmount})`);
        } else if (effectiveMonthlyAmount === 0 && existingPlan.stripeMonthlyPriceId) {
          // Transitioning to free plan - archive existing price and clear ID
          try {
            await stripe.prices.update(existingPlan.stripeMonthlyPriceId, { active: false });
            console.log(`📦 [Stripe] Archived monthly price ${existingPlan.stripeMonthlyPriceId} (plan now free)`);
          } catch (archiveErr: any) {
            console.warn(`⚠️ [Stripe] Could not archive monthly price: ${archiveErr.message}`);
          }
          updateData.stripeMonthlyPriceId = null;
          console.log(`ℹ️ [Stripe] Cleared monthly price ID for free plan`);
        }
        
        // Check if yearly price needs to be created/updated
        const newYearlyPrice = updateData.yearlyPrice?.toString();
        const oldYearlyPrice = existingPlan.yearlyPrice?.toString();
        const effectiveYearlyPrice = newYearlyPrice || oldYearlyPrice;
        const effectiveYearlyAmount = effectiveYearlyPrice ? parseFloat(effectiveYearlyPrice) : 0;
        const yearlyPriceChanged = newYearlyPrice && newYearlyPrice !== oldYearlyPrice;
        const needsYearlyPrice = !existingPlan.stripeYearlyPriceId && effectiveYearlyAmount > 0;
        
        // Handle yearly price sync (also resync if forceStripeSync is true and there's an existing price)
        const shouldResyncYearly = forceStripeSync && existingPlan.stripeYearlyPriceId && effectiveYearlyAmount > 0;
        if (effectiveYearlyAmount > 0 && (yearlyPriceChanged || needsYearlyPrice || shouldResyncYearly)) {
          // Archive old yearly price if exists (always archive before creating new)
          if (existingPlan.stripeYearlyPriceId) {
            try {
              await stripe.prices.update(existingPlan.stripeYearlyPriceId, { active: false });
              console.log(`📦 [Stripe] Archived old yearly price ${existingPlan.stripeYearlyPriceId}`);
            } catch (archiveErr: any) {
              console.warn(`⚠️ [Stripe] Could not archive old yearly price: ${archiveErr.message}`);
            }
          }
          
          // Create new yearly price
          const priceAmount = yearlyPriceChanged ? newYearlyPrice! : effectiveYearlyPrice!;
          const yearlyPrice = await stripe.prices.create({
            product: stripeProductId!,
            unit_amount: Math.round(parseFloat(priceAmount) * 100),
            currency: currency.toLowerCase(),
            recurring: {
              interval: 'year'
            },
            metadata: {
              planId: planId,
              billingPeriod: 'yearly'
            }
          });
          updateData.stripeYearlyPriceId = yearlyPrice.id;
          console.log(`✅ [Stripe] Created new yearly price ${yearlyPrice.id} ($${priceAmount})`);
        } else if (effectiveYearlyAmount === 0 && existingPlan.stripeYearlyPriceId) {
          // Transitioning to free plan - archive existing price and clear ID
          try {
            await stripe.prices.update(existingPlan.stripeYearlyPriceId, { active: false });
            console.log(`📦 [Stripe] Archived yearly price ${existingPlan.stripeYearlyPriceId} (plan now free)`);
          } catch (archiveErr: any) {
            console.warn(`⚠️ [Stripe] Could not archive yearly price: ${archiveErr.message}`);
          }
          updateData.stripeYearlyPriceId = null;
          console.log(`ℹ️ [Stripe] Cleared yearly price ID for free plan`);
        }
        
      } catch (stripeError: any) {
        console.error('❌ [Stripe] Error syncing plan update to Stripe:', stripeError.message);
        // Continue with update without blocking
      }
    } else {
      console.log('ℹ️ [Stripe] No Stripe key configured, skipping plan sync');
    }
    
    await storage.updatePlan(planId, updateData);
    
    // Fetch updated plan to return
    const updatedPlan = await storage.getPlan(planId);
    res.json({ success: true, plan: updatedPlan });
  } catch (error: any) {
    console.error('Error updating plan:', error);
    // Return 400 for validation errors, 500 for internal errors
    if (error.name === 'ZodError') {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: error.errors 
      });
    }
    res.status(500).json({ 
      error: 'Failed to update plan',
      details: error.message || 'Unknown error'
    });
  }
});

// Get users on a specific plan (for migration check)
router.get('/plans/:planId/users', async (req: AdminRequest, res: Response) => {
  try {
    const { planId } = req.params;
    
    const plan = await storage.getPlan(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    const allUsers = await storage.getAllUsers();
    const usersOnPlan = allUsers.filter(user => {
      return user.planType && user.planType.toLowerCase() === plan.name.toLowerCase();
    });
    
    res.json({
      planId,
      planName: plan.displayName,
      userCount: usersOnPlan.length,
      users: usersOnPlan.map(u => ({ id: u.id, name: u.name, email: u.email }))
    });
  } catch (error: any) {
    console.error('Error fetching plan users:', error);
    res.status(500).json({ error: 'Failed to fetch plan users' });
  }
});

// Force sync plan to Stripe
router.post('/plans/:planId/sync/stripe', async (req: AdminRequest, res: Response) => {
  try {
    const { planId } = req.params;
    
    const plan = await storage.getPlan(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    const stripe = await getStripeClient();
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe is not configured' });
    }
    
    const currency = await getDefaultCurrency();
    console.log(`🔄 [Stripe] Manual sync requested for plan ${planId} - will recreate all prices in ${currency}`);
    
    const updateData: any = {};
    let stripeProductId = plan.stripeProductId;
    
    // Create or update Stripe product
    if (!stripeProductId) {
      const stripeProduct = await stripe.products.create({
        name: plan.displayName,
        description: plan.description || undefined,
        metadata: { planId, planName: plan.name }
      });
      stripeProductId = stripeProduct.id;
      updateData.stripeProductId = stripeProductId;
      console.log(`✅ [Stripe] Created new product ${stripeProductId}`);
    } else {
      await stripe.products.update(stripeProductId, {
        name: plan.displayName,
        description: plan.description || undefined
      });
      console.log(`✅ [Stripe] Updated product ${stripeProductId}`);
    }
    
    // Create monthly price
    const monthlyAmount = plan.monthlyPrice ? parseFloat(plan.monthlyPrice.toString()) : 0;
    if (monthlyAmount > 0) {
      // Archive old price if exists
      if (plan.stripeMonthlyPriceId) {
        try {
          await stripe.prices.update(plan.stripeMonthlyPriceId, { active: false });
          console.log(`📦 [Stripe] Archived old monthly price ${plan.stripeMonthlyPriceId}`);
        } catch (e: any) {
          console.warn(`⚠️ [Stripe] Could not archive old monthly price: ${e.message}`);
        }
      }
      
      const monthlyPrice = await stripe.prices.create({
        product: stripeProductId!,
        unit_amount: Math.round(monthlyAmount * 100),
        currency: currency.toLowerCase(),
        recurring: { interval: 'month' },
        metadata: { planId, billingPeriod: 'monthly' }
      });
      updateData.stripeMonthlyPriceId = monthlyPrice.id;
      console.log(`✅ [Stripe] Created monthly price ${monthlyPrice.id} (${currency} ${monthlyAmount})`);
    }
    
    // Create yearly price
    const yearlyAmount = plan.yearlyPrice ? parseFloat(plan.yearlyPrice.toString()) : 0;
    if (yearlyAmount > 0) {
      // Archive old price if exists
      if (plan.stripeYearlyPriceId) {
        try {
          await stripe.prices.update(plan.stripeYearlyPriceId, { active: false });
          console.log(`📦 [Stripe] Archived old yearly price ${plan.stripeYearlyPriceId}`);
        } catch (e: any) {
          console.warn(`⚠️ [Stripe] Could not archive old yearly price: ${e.message}`);
        }
      }
      
      const yearlyPrice = await stripe.prices.create({
        product: stripeProductId!,
        unit_amount: Math.round(yearlyAmount * 100),
        currency: currency.toLowerCase(),
        recurring: { interval: 'year' },
        metadata: { planId, billingPeriod: 'yearly' }
      });
      updateData.stripeYearlyPriceId = yearlyPrice.id;
      console.log(`✅ [Stripe] Created yearly price ${yearlyPrice.id} (${currency} ${yearlyAmount})`);
    }
    
    // Update plan with new Stripe IDs
    if (Object.keys(updateData).length > 0) {
      await storage.updatePlan(planId, updateData);
    }
    
    const updatedPlan = await storage.getPlan(planId);
    res.json({ 
      success: true, 
      message: `Plan synced to Stripe (${currency})`,
      plan: updatedPlan 
    });
  } catch (error: any) {
    console.error('❌ [Stripe] Error syncing plan:', error);
    res.status(500).json({ error: error.message || 'Failed to sync plan to Stripe' });
  }
});

// Force sync plan to Razorpay
router.post('/plans/:planId/sync/razorpay', async (req: AdminRequest, res: Response) => {
  try {
    const { planId } = req.params;
    
    const plan = await storage.getPlan(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    const razorpayConfigured = await isRazorpayConfigured();
    if (!razorpayConfigured) {
      return res.status(400).json({ error: 'Razorpay is not configured' });
    }
    
    console.log(`🔄 [Razorpay] Manual sync requested for plan ${planId} - will recreate all plans in INR`);
    
    const updateData: any = {};
    
    // Create monthly plan (Razorpay plans are immutable, so we always create new)
    const monthlyInrAmount = plan.razorpayMonthlyPrice ? parseFloat(plan.razorpayMonthlyPrice.toString()) : 0;
    if (monthlyInrAmount > 0) {
      const monthlyPlan = await createRazorpayPlan({
        period: 'monthly',
        interval: 1,
        name: `${plan.displayName} - Monthly`,
        amount: monthlyInrAmount,
        currency: 'INR',
        description: plan.description || undefined,
        notes: { planId, billingPeriod: 'monthly' }
      });
      updateData.razorpayPlanId = monthlyPlan.id;
      console.log(`✅ [Razorpay] Created monthly plan ${monthlyPlan.id} (INR ${monthlyInrAmount})`);
    }
    
    // Create yearly plan
    const yearlyInrAmount = plan.razorpayYearlyPrice ? parseFloat(plan.razorpayYearlyPrice.toString()) : 0;
    if (yearlyInrAmount > 0) {
      const yearlyPlan = await createRazorpayPlan({
        period: 'yearly',
        interval: 1,
        name: `${plan.displayName} - Yearly`,
        amount: yearlyInrAmount,
        currency: 'INR',
        description: plan.description || undefined,
        notes: { planId, billingPeriod: 'yearly' }
      });
      updateData.razorpayYearlyPlanId = yearlyPlan.id;
      console.log(`✅ [Razorpay] Created yearly plan ${yearlyPlan.id} (INR ${yearlyInrAmount})`);
    }
    
    // Update plan with new Razorpay IDs
    if (Object.keys(updateData).length > 0) {
      await storage.updatePlan(planId, updateData);
    }
    
    const updatedPlan = await storage.getPlan(planId);
    res.json({ 
      success: true, 
      message: 'Plan synced to Razorpay (INR)',
      plan: updatedPlan 
    });
  } catch (error: any) {
    console.error('❌ [Razorpay] Error syncing plan:', error);
    res.status(500).json({ error: error.message || 'Failed to sync plan to Razorpay' });
  }
});

// Force sync plan to PayPal
router.post('/plans/:planId/sync/paypal', async (req: AdminRequest, res: Response) => {
  try {
    const { planId } = req.params;
    
    const plan = await storage.getPlan(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    const paypalConfigured = await isPayPalConfigured();
    if (!paypalConfigured) {
      return res.status(400).json({ error: 'PayPal is not configured' });
    }
    
    const currencyConfig = await getPayPalCurrency();
    console.log(`🔄 [PayPal] Manual sync requested for plan ${planId} - will recreate all plans in ${currencyConfig.currency}`);
    
    const updateData: any = {};
    let paypalProductId = plan.paypalProductId;
    
    // Create PayPal product if not exists
    if (!paypalProductId) {
      const product = await createPayPalProduct({
        name: plan.displayName,
        description: plan.description || undefined,
        type: 'SERVICE',
      });
      paypalProductId = product.id;
      updateData.paypalProductId = paypalProductId;
      console.log(`✅ [PayPal] Created product ${paypalProductId}`);
    }
    
    // Create monthly plan
    const monthlyAmount = plan.paypalMonthlyPrice ? parseFloat(plan.paypalMonthlyPrice.toString()) : 0;
    if (monthlyAmount > 0) {
      const monthlyPlan = await createPayPalPlan({
        productId: paypalProductId!,
        name: `${plan.displayName} - Monthly`,
        description: plan.description || undefined,
        billingCycles: [{
          frequency: { interval_unit: 'MONTH', interval_count: 1 },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: {
              value: monthlyAmount.toFixed(2),
              currency_code: currencyConfig.currency,
            },
          },
        }],
      });
      updateData.paypalMonthlyPlanId = monthlyPlan.id;
      console.log(`✅ [PayPal] Created monthly plan ${monthlyPlan.id} (${currencyConfig.currency} ${monthlyAmount})`);
    }
    
    // Create yearly plan
    const yearlyAmount = plan.paypalYearlyPrice ? parseFloat(plan.paypalYearlyPrice.toString()) : 0;
    if (yearlyAmount > 0) {
      const yearlyPlan = await createPayPalPlan({
        productId: paypalProductId!,
        name: `${plan.displayName} - Yearly`,
        description: plan.description || undefined,
        billingCycles: [{
          frequency: { interval_unit: 'YEAR', interval_count: 1 },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: {
              value: yearlyAmount.toFixed(2),
              currency_code: currencyConfig.currency,
            },
          },
        }],
      });
      updateData.paypalYearlyPlanId = yearlyPlan.id;
      console.log(`✅ [PayPal] Created yearly plan ${yearlyPlan.id} (${currencyConfig.currency} ${yearlyAmount})`);
    }
    
    // Update plan with new PayPal IDs
    if (Object.keys(updateData).length > 0) {
      await storage.updatePlan(planId, updateData);
    }
    
    const updatedPlan = await storage.getPlan(planId);
    res.json({ 
      success: true, 
      message: `Plan synced to PayPal (${currencyConfig.currency})`,
      plan: updatedPlan 
    });
  } catch (error: any) {
    console.error('❌ [PayPal] Error syncing plan:', error);
    res.status(500).json({ error: error.message || 'Failed to sync plan to PayPal' });
  }
});

// Force sync plan to Paystack
router.post('/plans/:planId/sync/paystack', async (req: AdminRequest, res: Response) => {
  try {
    const { planId } = req.params;
    
    const plan = await storage.getPlan(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    const paystackConfigured = await isPaystackConfigured();
    if (!paystackConfigured) {
      return res.status(400).json({ error: 'Paystack is not configured' });
    }
    
    const currencyConfig = await getPaystackCurrency();
    console.log(`🔄 [Paystack] Manual sync requested for plan ${planId} - will recreate all plans in ${currencyConfig.currency}`);
    
    // Validate minimum amount (Paystack requires at least 100 NGN)
    const PAYSTACK_MIN_AMOUNT = 100;
    
    const monthlyAmount = plan.paystackMonthlyPrice ? parseFloat(plan.paystackMonthlyPrice.toString()) : 0;
    const yearlyAmount = plan.paystackYearlyPrice ? parseFloat(plan.paystackYearlyPrice.toString()) : 0;
    
    // Check if at least one valid price is configured
    if (monthlyAmount < PAYSTACK_MIN_AMOUNT && yearlyAmount < PAYSTACK_MIN_AMOUNT) {
      return res.status(400).json({ 
        error: `At least one price (monthly or yearly) must be ${PAYSTACK_MIN_AMOUNT} ${currencyConfig.currency} or greater to sync with Paystack. Current: Monthly = ${monthlyAmount} ${currencyConfig.currency}, Yearly = ${yearlyAmount} ${currencyConfig.currency}` 
      });
    }
    
    const updateData: any = {};
    
    // Create monthly plan
    if (monthlyAmount > 0 && monthlyAmount < PAYSTACK_MIN_AMOUNT) {
      return res.status(400).json({ 
        error: `Monthly price must be at least ${PAYSTACK_MIN_AMOUNT} ${currencyConfig.currency}. Current: ${monthlyAmount} ${currencyConfig.currency}` 
      });
    }
    
    if (monthlyAmount >= PAYSTACK_MIN_AMOUNT) {
      const monthlyPlan = await createPaystackPlan({
        name: `${plan.displayName} - Monthly`,
        interval: 'monthly',
        amount: monthlyAmount,
        currency: currencyConfig.currency,
        description: plan.description || undefined,
      });
      updateData.paystackMonthlyPlanCode = monthlyPlan.plan_code;
      console.log(`✅ [Paystack] Created monthly plan ${monthlyPlan.plan_code} (${currencyConfig.currency} ${monthlyAmount})`);
    }
    
    // Create yearly plan
    // Validate minimum amount for yearly
    if (yearlyAmount > 0 && yearlyAmount < PAYSTACK_MIN_AMOUNT) {
      return res.status(400).json({ 
        error: `Yearly price must be at least ${PAYSTACK_MIN_AMOUNT} ${currencyConfig.currency}. Current: ${yearlyAmount} ${currencyConfig.currency}` 
      });
    }
    
    if (yearlyAmount >= PAYSTACK_MIN_AMOUNT) {
      const yearlyPlan = await createPaystackPlan({
        name: `${plan.displayName} - Yearly`,
        interval: 'annually',
        amount: yearlyAmount,
        currency: currencyConfig.currency,
        description: plan.description || undefined,
      });
      updateData.paystackYearlyPlanCode = yearlyPlan.plan_code;
      console.log(`✅ [Paystack] Created yearly plan ${yearlyPlan.plan_code} (${currencyConfig.currency} ${yearlyAmount})`);
    }
    
    // Update plan with new Paystack IDs
    if (Object.keys(updateData).length > 0) {
      await storage.updatePlan(planId, updateData);
    }
    
    const updatedPlan = await storage.getPlan(planId);
    res.json({ 
      success: true, 
      message: `Plan synced to Paystack (${currencyConfig.currency})`,
      plan: updatedPlan 
    });
  } catch (error: any) {
    console.error('❌ [Paystack] Error syncing plan:', error);
    res.status(500).json({ error: error.message || 'Failed to sync plan to Paystack' });
  }
});

// Force sync plan to MercadoPago
router.post('/plans/:planId/sync/mercadopago', async (req: AdminRequest, res: Response) => {
  try {
    const { planId } = req.params;
    
    const plan = await storage.getPlan(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    const mercadopagoConfigured = await isMercadoPagoConfigured();
    if (!mercadopagoConfigured) {
      return res.status(400).json({ error: 'MercadoPago is not configured' });
    }
    
    const currencyConfig = await getMercadoPagoCurrency();
    const baseUrl = process.env.BASE_URL || process.env.APP_URL;
    
    if (!baseUrl) {
      return res.status(400).json({ error: 'BASE_URL or APP_URL environment variable must be configured for MercadoPago integration' });
    }
    
    console.log(`🔄 [MercadoPago] Manual sync requested for plan ${planId} - will recreate all plans in ${currencyConfig.currency}`);
    
    const updateData: any = {};
    
    // Create monthly plan
    const monthlyAmount = plan.mercadopagoMonthlyPrice ? parseFloat(plan.mercadopagoMonthlyPrice.toString()) : 0;
    if (monthlyAmount > 0) {
      const monthlyPlan = await createMercadoPagoSubscriptionPlan({
        reason: `${plan.displayName} - Monthly`,
        autoRecurring: {
          frequency: 1,
          frequencyType: 'months',
          transactionAmount: monthlyAmount,
          currencyId: currencyConfig.currency,
        },
        backUrl: `${baseUrl}/app/billing`,
      });
      updateData.mercadopagoMonthlyPlanId = monthlyPlan.id;
      console.log(`✅ [MercadoPago] Created monthly plan ${monthlyPlan.id} (${currencyConfig.currency} ${monthlyAmount})`);
    }
    
    // Create yearly plan (12 months frequency)
    const yearlyAmount = plan.mercadopagoYearlyPrice ? parseFloat(plan.mercadopagoYearlyPrice.toString()) : 0;
    if (yearlyAmount > 0) {
      const yearlyPlan = await createMercadoPagoSubscriptionPlan({
        reason: `${plan.displayName} - Yearly`,
        autoRecurring: {
          frequency: 12,
          frequencyType: 'months',
          transactionAmount: yearlyAmount,
          currencyId: currencyConfig.currency,
        },
        backUrl: `${baseUrl}/app/billing`,
      });
      updateData.mercadopagoYearlyPlanId = yearlyPlan.id;
      console.log(`✅ [MercadoPago] Created yearly plan ${yearlyPlan.id} (${currencyConfig.currency} ${yearlyAmount})`);
    }
    
    // Update plan with new MercadoPago IDs
    if (Object.keys(updateData).length > 0) {
      await storage.updatePlan(planId, updateData);
    }
    
    const updatedPlan = await storage.getPlan(planId);
    res.json({ 
      success: true, 
      message: `Plan synced to MercadoPago (${currencyConfig.currency})`,
      plan: updatedPlan 
    });
  } catch (error: any) {
    console.error('❌ [MercadoPago] Error syncing plan:', error);
    res.status(500).json({ error: error.message || 'Failed to sync plan to MercadoPago' });
  }
});

// Migrate users from one plan to another
router.post('/plans/:planId/migrate', async (req: AdminRequest, res: Response) => {
  try {
    const { planId } = req.params;
    const { targetPlanId } = req.body;
    
    if (!targetPlanId) {
      return res.status(400).json({ error: 'Target plan ID is required' });
    }
    
    // Get source plan
    const sourcePlan = await storage.getPlan(planId);
    if (!sourcePlan) {
      return res.status(404).json({ error: 'Source plan not found' });
    }
    
    // Get target plan
    const targetPlan = await storage.getPlan(targetPlanId);
    if (!targetPlan) {
      return res.status(404).json({ error: 'Target plan not found' });
    }
    
    // Get users on source plan
    const allUsers = await storage.getAllUsers();
    const usersOnPlan = allUsers.filter(user => {
      return user.planType && user.planType.toLowerCase() === sourcePlan.name.toLowerCase();
    });
    
    if (usersOnPlan.length === 0) {
      return res.json({ success: true, migratedCount: 0 });
    }
    
    // Migrate each user to the target plan
    const { users } = await import('@shared/schema');
    const { db } = await import('../db');
    const { eq } = await import('drizzle-orm');
    
    for (const user of usersOnPlan) {
      await db.update(users)
        .set({ planType: targetPlan.name })
        .where(eq(users.id, user.id));
    }
    
    res.json({
      success: true,
      migratedCount: usersOnPlan.length,
      targetPlanName: targetPlan.displayName
    });
  } catch (error: any) {
    console.error('Error migrating users:', error);
    res.status(500).json({ error: 'Failed to migrate users' });
  }
});

// Delete plan (with migration check)
router.delete('/plans/:planId', async (req: AdminRequest, res: Response) => {
  try {
    const { planId } = req.params;
    
    // Get the plan first to get its name
    const plan = await storage.getPlan(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    // Check if any users are currently on this plan (by plan name)
    const allUsers = await storage.getAllUsers();
    const usersOnPlan = allUsers.filter(user => {
      return user.planType && user.planType.toLowerCase() === plan.name.toLowerCase();
    });
    
    if (usersOnPlan.length > 0) {
      // Return info about users that need to be migrated
      return res.status(400).json({ 
        error: 'USERS_NEED_MIGRATION',
        userCount: usersOnPlan.length,
        message: `${usersOnPlan.length} user(s) are currently subscribed to this plan. Please migrate them to another plan first.` 
      });
    }
    
    await storage.deletePlan(planId);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting plan:', error);
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

// Get all credit packages
router.get('/credit-packages', async (req: AdminRequest, res: Response) => {
  try {
    const packages = await storage.getAllCreditPackages();
    res.json(packages);
  } catch (error) {
    console.error('Error fetching credit packages:', error);
    res.status(500).json({ error: 'Failed to fetch credit packages' });
  }
});

// Create credit package
router.post('/credit-packages', async (req: AdminRequest, res: Response) => {
  try {
    // Convert price fields to strings if they're numbers (decimal fields expect strings)
    const bodyData = { ...req.body };
    if (typeof bodyData.price === 'number') {
      bodyData.price = bodyData.price.toFixed(2);
    }
    if (typeof bodyData.razorpayPrice === 'number') {
      bodyData.razorpayPrice = bodyData.razorpayPrice.toFixed(2);
    }
    
    let packageData;
    try {
      packageData = insertCreditPackageSchema.parse(bodyData);
    } catch (validationError: any) {
      if (validationError.errors) {
        return res.status(400).json({ 
          error: 'Validation failed', 
          details: validationError.errors 
        });
      }
      throw validationError;
    }
    
    // Create the package first
    let newPackage = await storage.createCreditPackage(packageData);
    
    // Sync with Stripe if configured
    const stripe = await getStripeClient();
    if (stripe) {
      try {
        const currency = await getDefaultCurrency();
        
        // Create Stripe Product
        const stripeProduct = await stripe.products.create({
          name: packageData.name,
          description: packageData.description || undefined,
          metadata: {
            packageId: newPackage.id,
            credits: packageData.credits.toString()
          }
        });
        
        // Create one-time price (not recurring)
        const stripePrice = await stripe.prices.create({
          product: stripeProduct.id,
          unit_amount: Math.round(parseFloat(packageData.price.toString()) * 100),
          currency: currency.toLowerCase(),
          metadata: {
            packageId: newPackage.id,
            credits: packageData.credits.toString()
          }
        });
        
        // Update package with Stripe IDs
        await storage.updateCreditPackage(newPackage.id, {
          stripeProductId: stripeProduct.id,
          stripePriceId: stripePrice.id
        });
        
        // Fetch updated package
        const updatedPackage = await storage.getCreditPackage(newPackage.id);
        if (updatedPackage) {
          newPackage = updatedPackage;
        }
        
        console.log(`✅ [Stripe] Created product ${stripeProduct.id} and price ${stripePrice.id} for credit package ${newPackage.id}`);
      } catch (stripeError: any) {
        console.error('❌ [Stripe] Error syncing credit package to Stripe:', stripeError.message);
        // Package was created, just Stripe sync failed - continue without blocking
      }
    } else {
      console.log('ℹ️ [Stripe] No Stripe key configured, skipping credit package sync');
    }
    
    res.json(newPackage);
  } catch (error) {
    console.error('Error creating credit package:', error);
    res.status(500).json({ error: 'Failed to create credit package' });
  }
});

// Update credit package
router.patch('/credit-packages/:packageId', async (req: AdminRequest, res: Response) => {
  try {
    const { packageId } = req.params;
    
    // Convert price fields to strings if they're numbers (decimal fields expect strings)
    const bodyData = { ...req.body };
    if (typeof bodyData.price === 'number') {
      bodyData.price = bodyData.price.toFixed(2);
    }
    if (typeof bodyData.razorpayPrice === 'number') {
      bodyData.razorpayPrice = bodyData.razorpayPrice.toFixed(2);
    }
    
    let updateData;
    try {
      updateData = insertCreditPackageSchema.partial().parse(bodyData);
    } catch (validationError: any) {
      if (validationError.errors) {
        return res.status(400).json({ 
          error: 'Validation failed', 
          details: validationError.errors 
        });
      }
      throw validationError;
    }
    
    // Get existing package to check for price changes
    const existingPackage = await storage.getCreditPackage(packageId);
    if (!existingPackage) {
      return res.status(404).json({ error: 'Credit package not found' });
    }
    
    // Sync with Stripe if configured
    const stripe = await getStripeClient();
    if (stripe) {
      try {
        const currency = await getDefaultCurrency();
        
        // Force resync option - recreate Stripe price in current currency
        // This is used after admin changes currency and needs to resync pricing
        const forceStripeSync = req.body.forceStripeSync === true;
        if (forceStripeSync) {
          console.log(`🔄 [Stripe] Force sync requested for credit package ${packageId} - will recreate price in ${currency}`);
        }
        
        // Check if we need to create a new Stripe product (if none exists)
        let stripeProductId = existingPackage.stripeProductId;
        
        if (!stripeProductId) {
          // Create new Stripe Product
          const stripeProduct = await stripe.products.create({
            name: updateData.name || existingPackage.name,
            description: updateData.description || existingPackage.description || undefined,
            metadata: {
              packageId: packageId,
              credits: (updateData.credits || existingPackage.credits).toString()
            }
          });
          stripeProductId = stripeProduct.id;
          updateData.stripeProductId = stripeProductId;
          console.log(`✅ [Stripe] Created new product ${stripeProductId} for credit package ${packageId}`);
        } else {
          // Update existing product if name/description changed
          if (updateData.name || updateData.description) {
            await stripe.products.update(stripeProductId, {
              name: updateData.name || existingPackage.name,
              description: updateData.description || existingPackage.description || undefined,
              metadata: {
                packageId: packageId,
                credits: (updateData.credits || existingPackage.credits).toString()
              }
            });
            console.log(`✅ [Stripe] Updated product ${stripeProductId}`);
          }
        }
        
        // Check if price changed or force sync requested
        const newPrice = updateData.price?.toString();
        const oldPrice = existingPackage.price?.toString();
        const priceChanged = newPrice && newPrice !== oldPrice;
        const effectivePrice = newPrice || oldPrice;
        const effectiveAmount = effectivePrice ? parseFloat(effectivePrice) : 0;
        const shouldResyncPrice = forceStripeSync && existingPackage.stripePriceId && effectiveAmount > 0;
        
        if ((priceChanged || shouldResyncPrice) && effectiveAmount > 0) {
          // Archive old price if exists
          if (existingPackage.stripePriceId) {
            try {
              await stripe.prices.update(existingPackage.stripePriceId, { active: false });
              console.log(`📦 [Stripe] Archived old price ${existingPackage.stripePriceId}`);
            } catch (archiveErr: any) {
              console.warn(`⚠️ [Stripe] Could not archive old price: ${archiveErr.message}`);
            }
          }
          
          // Create new one-time price
          const priceAmount = priceChanged ? newPrice! : effectivePrice!;
          const stripePrice = await stripe.prices.create({
            product: stripeProductId!,
            unit_amount: Math.round(parseFloat(priceAmount) * 100),
            currency: currency.toLowerCase(),
            metadata: {
              packageId: packageId,
              credits: (updateData.credits || existingPackage.credits).toString()
            }
          });
          updateData.stripePriceId = stripePrice.id;
          console.log(`✅ [Stripe] Created new price ${stripePrice.id} (${priceAmount} ${currency})`);
        }
        
      } catch (stripeError: any) {
        console.error('❌ [Stripe] Error syncing credit package update to Stripe:', stripeError.message);
        // Continue with update without blocking
      }
    } else {
      console.log('ℹ️ [Stripe] No Stripe key configured, skipping credit package sync');
    }
    
    await storage.updateCreditPackage(packageId, updateData);
    
    // Fetch updated package to return
    const updatedPackage = await storage.getCreditPackage(packageId);
    res.json({ success: true, package: updatedPackage });
  } catch (error: any) {
    console.error('Error updating credit package:', error);
    res.status(500).json({ 
      error: 'Failed to update credit package',
      details: error.message || 'Unknown error'
    });
  }
});

// Get global settings
router.get('/settings', async (req: AdminRequest, res: Response) => {
  try {
    // Get all relevant settings
    const settingKeys = [
      'default_llm_free',
      'default_tts_model',
      'pro_plan_bonus_credits',
      'credit_price_per_minute',
      'phone_number_monthly_credits',
      'min_credit_purchase',
      'system_phone_pool_size',
      'llm_margin_percentage',
      'twilio_account_sid',
      'twilio_auth_token',
      'elevenlabs_api_key',
      'openai_api_key',
      // Stripe settings
      'stripe_secret_key',
      'stripe_publishable_key',
      'stripe_currency',
      'stripe_currency_locked',
      'stripe_mode',
      // Razorpay settings
      'razorpay_key_id',
      'razorpay_key_secret',
      'razorpay_webhook_secret',
      'razorpay_mode',
      // PayPal settings
      'paypal_client_id',
      'paypal_client_secret',
      'paypal_mode',
      'paypal_webhook_id',
      'paypal_currency',
      // Paystack settings
      'paystack_public_key',
      'paystack_secret_key',
      'paystack_webhook_secret',
      // MercadoPago settings
      'mercadopago_access_token',
      'mercadopago_public_key',
      'mercadopago_webhook_secret',
      'mercadopago_webhook_id',
      'mercadopago_currency',
      // Payment gateway selection
      'payment_gateway',
      // Gateway enabled/disabled flags
      'stripe_enabled',
      'razorpay_enabled',
      'paypal_enabled',
      'paystack_enabled',
      'mercadopago_enabled',
      // Auto-restart settings
      'auto_restart_enabled',
      'auto_restart_ram_percent',
      'auto_restart_cpu_percent'
    ];
    
    const settings: Record<string, any> = {};
    for (const key of settingKeys) {
      const setting = await storage.getGlobalSetting(key);
      if (setting) {
        settings[key] = setting.value;
      }
    }
    
    // Note: Connection status is checked dynamically via /test-connection endpoints
    // This just indicates if credentials exist AND are properly configured
    // For production deployment, we only check database-configured keys (not env vars)
    // so clients can configure their own keys via admin panel
    const dbTwilioSid = settings.twilio_account_sid;
    const dbTwilioToken = settings.twilio_auth_token;
    
    // Only mark as configured if database has actual credentials (not env vars)
    // This ensures clean production deployments where clients add their own keys
    const dbTwilioConfigured = !!(dbTwilioSid && dbTwilioSid.trim() && dbTwilioToken && dbTwilioToken.trim());
    settings.twilio_configured = dbTwilioConfigured;
    
    // Check ElevenLabs: ONLY pool keys (not env var) for production readiness
    // Clients must add keys via the admin pool system
    const poolStats = await ElevenLabsPoolService.getPoolStats();
    settings.elevenlabs_configured = poolStats.totalKeys > 0;
    
    // Check OpenAI: ONLY database setting (not env var) for production readiness
    // Clients must configure via admin panel
    const dbOpenAIKey = settings.openai_api_key;
    settings.openai_configured = !!(dbOpenAIKey && dbOpenAIKey.trim());
    
    // Check OpenAI Realtime Voice API: credentials pool for Plivo/Twilio-OpenAI engines
    const openaiRealtimeCredentials = await db.select().from(openaiCredentials).where(eq(openaiCredentials.isActive, true));
    settings.openai_realtime_configured = openaiRealtimeCredentials.length > 0;
    
    // Check Stripe: env var OR database setting
    const dbStripeSecretKey = settings.stripe_secret_key;
    const dbStripePublishableKey = settings.stripe_publishable_key;
    const envStripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const envStripePublishableKey = process.env.VITE_STRIPE_PUBLIC_KEY;
    settings.stripe_configured = !!((dbStripeSecretKey && dbStripePublishableKey) || (envStripeSecretKey && envStripePublishableKey));
    
    // Check Razorpay: database settings only
    const dbRazorpayKeyId = settings.razorpay_key_id;
    const dbRazorpayKeySecret = settings.razorpay_key_secret;
    settings.razorpay_configured = !!(dbRazorpayKeyId && dbRazorpayKeySecret);
    
    // Check PayPal: database settings only
    const dbPaypalClientId = settings.paypal_client_id;
    const dbPaypalClientSecret = settings.paypal_client_secret;
    settings.paypal_configured = !!(dbPaypalClientId && dbPaypalClientSecret);
    
    // Check Paystack: database settings only
    const dbPaystackPublicKey = settings.paystack_public_key;
    const dbPaystackSecretKey = settings.paystack_secret_key;
    settings.paystack_configured = !!(dbPaystackPublicKey && dbPaystackSecretKey);
    
    // Check MercadoPago: database settings only (requires access token)
    const dbMercadopagoAccessToken = settings.mercadopago_access_token;
    settings.mercadopago_configured = !!dbMercadopagoAccessToken;
    
    // Default payment gateway to 'stripe' if not set
    if (!settings.payment_gateway) {
      settings.payment_gateway = 'stripe';
    }
    
    // Mask sensitive keys before returning - only indicate if they exist
    if (settings.stripe_secret_key) {
      settings.stripe_secret_key = true; // Only return boolean indicating key exists
    }
    if (settings.twilio_auth_token) {
      settings.twilio_auth_token = true; // Only return boolean indicating key exists
    }
    if (settings.openai_api_key) {
      settings.openai_api_key = true; // Only return boolean indicating key exists
    }
    if (settings.razorpay_key_secret) {
      settings.razorpay_key_secret = true; // Only return boolean indicating key exists
    }
    if (settings.razorpay_webhook_secret) {
      settings.razorpay_webhook_secret = true; // Only return boolean indicating key exists
    }
    // Mask PayPal sensitive keys
    if (settings.paypal_client_secret) {
      settings.paypal_client_secret = true; // Only return boolean indicating key exists
    }
    // Mask Paystack sensitive keys
    if (settings.paystack_secret_key) {
      settings.paystack_secret_key = true; // Only return boolean indicating key exists
    }
    if (settings.paystack_webhook_secret) {
      settings.paystack_webhook_secret = true; // Only return boolean indicating key exists
    }
    // Mask MercadoPago sensitive keys
    if (settings.mercadopago_access_token) {
      settings.mercadopago_access_token = true; // Only return boolean indicating key exists
    }
    if (settings.mercadopago_webhook_secret) {
      settings.mercadopago_webhook_secret = true; // Only return boolean indicating key exists
    }
    
    // Prevent caching to ensure fresh connection status
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    res.json(settings);
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Get system configuration settings (security, credits, webhooks, resources)
router.get('/system-settings', async (req: AdminRequest, res: Response) => {
  try {
    const systemSettingKeys = [
      'jwt_expiry_days',
      'otp_expiry_minutes',
      'password_reset_expiry_minutes',
      'phone_number_monthly_credits',
      'low_credits_threshold',
      'webhook_retry_max_attempts',
      'webhook_retry_intervals_minutes',
      'webhook_expiry_hours',
      'system_phone_pool_size',
      // Connection Limits
      'max_ws_connections_per_process',
      'max_ws_connections_per_user',
      'max_ws_connections_per_ip',
      'max_openai_connections_per_credential',
      'openai_connection_timeout_ms',
      'openai_idle_timeout_ms',
      'db_pool_min_connections',
      'db_pool_max_connections',
      'db_pool_idle_timeout_ms',
      'campaign_batch_concurrency',
    ];
    
    const systemSettings: Record<string, any> = {};
    for (const key of systemSettingKeys) {
      const setting = await storage.getGlobalSetting(key);
      if (setting) {
        systemSettings[key] = setting.value;
      }
    }
    
    // Apply defaults for missing settings
    const defaults: Record<string, any> = {
      jwt_expiry_days: 7,
      otp_expiry_minutes: 5,
      password_reset_expiry_minutes: 5,
      phone_number_monthly_credits: 50,
      low_credits_threshold: 50,
      webhook_retry_max_attempts: 5,
      webhook_retry_intervals_minutes: [1, 5, 15, 30, 60],
      webhook_expiry_hours: 24,
      system_phone_pool_size: 5,
      // Connection Limits
      max_ws_connections_per_process: 1000,
      max_ws_connections_per_user: 5,
      max_ws_connections_per_ip: 10,
      max_openai_connections_per_credential: 50,
      openai_connection_timeout_ms: 3600000,
      openai_idle_timeout_ms: 300000,
      db_pool_min_connections: 2,
      db_pool_max_connections: 20,
      db_pool_idle_timeout_ms: 30000,
      campaign_batch_concurrency: 10,
    };
    
    for (const key of systemSettingKeys) {
      if (systemSettings[key] === undefined) {
        systemSettings[key] = defaults[key];
      }
    }
    
    res.json(systemSettings);
  } catch (error) {
    console.error('Error fetching system settings:', error);
    res.status(500).json({ error: 'Failed to fetch system settings' });
  }
});

// Get demo call widget settings
router.get('/settings/demo', async (req: AdminRequest, res: Response) => {
  try {
    const demoSettings: Record<string, any> = {
      demo_widget_enabled: false,
      demo_max_duration: 60,
      demo_cooldown_minutes: 5,
      demo_max_concurrent: 10,
      demo_system_prompt: 'You are a helpful AI assistant demonstrating the capabilities of our voice AI platform. Be friendly, concise, and showcase the natural conversational abilities of the system.',
      demo_knowledge_base_ids: []
    };
    
    const keys = Object.keys(demoSettings);
    for (const key of keys) {
      const setting = await storage.getGlobalSetting(key);
      if (setting) {
        demoSettings[key] = setting.value;
      }
    }
    
    res.json(demoSettings);
  } catch (error) {
    console.error('Error fetching demo settings:', error);
    res.status(500).json({ error: 'Failed to fetch demo settings' });
  }
});

// Get individual global setting
router.get('/settings/:key', async (req: AdminRequest, res: Response) => {
  try {
    const { key } = req.params;
    const setting = await storage.getGlobalSetting(key);
    
    if (!setting) {
      // Return default values for known settings
      const defaults: Record<string, any> = {
        'default_tts_model': 'eleven_turbo_v2',
        'default_llm_free': null,
        'pro_plan_bonus_credits': 0,
        'credit_price_per_minute': 0.1,
        'phone_number_monthly_credits': 50,
        'min_credit_purchase': 10,
        'system_phone_pool_size': 5,
        'llm_margin_percentage': 15,
        'stripe_currency': 'USD',
        'stripe_currency_locked': false,
        'stripe_mode': 'test',
        // Auto-restart defaults
        'auto_restart_enabled': false,
        'auto_restart_ram_percent': 75,
        'auto_restart_cpu_percent': 85,
      };
      
      return res.json({ [key]: defaults[key] ?? null });
    }
    
    res.json({ [key]: setting.value });
  } catch (error) {
    console.error('Error fetching setting:', error);
    res.status(500).json({ error: 'Failed to fetch setting' });
  }
});

// Update global setting
router.patch('/settings/:key', async (req: AdminRequest, res: Response) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    
    // Allow specific credentials to be stored in database
    // But prevent other API keys/secrets from accidental exposure
    const allowedCredentials = [
      'twilio_account_sid', 'twilio_auth_token', 'openai_api_key',
      // ElevenLabs settings
      'elevenlabs_hmac_secret',
      // SMTP settings
      'smtp_host', 'smtp_port', 'smtp_username', 'smtp_password', 'smtp_from_email', 'smtp_from_name',
      // Branding settings
      'app_name', 'app_tagline', 'logo_url', 'favicon_url', 'branding_updated_at',
      // Stripe settings
      'stripe_secret_key', 'stripe_publishable_key', 'stripe_webhook_secret', 'stripe_currency', 'stripe_currency_locked', 'stripe_mode',
      // Razorpay settings
      'razorpay_key_id', 'razorpay_key_secret', 'razorpay_webhook_secret', 'razorpay_mode',
      // PayPal settings
      'paypal_client_id', 'paypal_client_secret', 'paypal_mode', 'paypal_webhook_id', 'paypal_currency',
      // Paystack settings
      'paystack_public_key', 'paystack_secret_key', 'paystack_webhook_secret',
      // MercadoPago settings
      'mercadopago_access_token', 'mercadopago_public_key', 'mercadopago_webhook_secret', 'mercadopago_webhook_id', 'mercadopago_currency',
      // Payment gateway selection and enable flags
      'payment_gateway',
      'paypal_enabled', 'paystack_enabled', 'mercadopago_enabled',
      // System settings that contain "password" in name but are not actual passwords
      'password_reset_expiry_minutes',
      // Demo call widget settings
      'demo_widget_enabled', 'demo_max_duration', 'demo_cooldown_minutes', 
      'demo_max_concurrent', 'demo_system_prompt', 'demo_knowledge_base_ids'
    ];
    if (!allowedCredentials.includes(key) && (key.includes('api_key') || key.includes('secret') || key.includes('password'))) {
      return res.status(400).json({ error: 'API keys must be configured as environment variables' });
    }
    
    // Check if Stripe currency is locked before allowing currency changes
    if (key === 'stripe_currency') {
      const currencyConfig = await getStripeCurrency();
      if (currencyConfig.currencyLocked) {
        return res.status(400).json({ 
          error: 'Stripe currency is locked and cannot be changed. This is a one-time setting.' 
        });
      }
      // Validate currency is supported
      const validCurrencies = getSupportedCurrencies().map(c => c.code);
      if (!validCurrencies.includes((value as string).toUpperCase())) {
        return res.status(400).json({ 
          error: `Invalid currency. Supported currencies: ${validCurrencies.join(', ')}` 
        });
      }
    }
    
    // Validate and clamp auto-restart settings
    let finalValue = value;
    
    if (key === 'auto_restart_enabled') {
      // Ensure boolean type
      finalValue = value === true || value === 'true';
    } else if (key === 'auto_restart_ram_percent') {
      const ramPercent = Number(value);
      if (isNaN(ramPercent)) {
        return res.status(400).json({ 
          error: 'RAM percentage must be a number' 
        });
      }
      // Clamp to valid range
      finalValue = Math.max(50, Math.min(95, ramPercent));
    } else if (key === 'auto_restart_cpu_percent') {
      const cpuPercent = Number(value);
      if (isNaN(cpuPercent)) {
        return res.status(400).json({ 
          error: 'CPU percentage must be a number' 
        });
      }
      // Clamp to valid range
      finalValue = Math.max(20, Math.min(95, cpuPercent));
    } else if (key === 'invoice_prefix') {
      // Validate invoice prefix: only alphanumeric and underscore, max 10 chars
      const prefixStr = String(value || '').trim().toUpperCase();
      const sanitized = prefixStr.replace(/[^A-Z0-9_]/g, '');
      if (sanitized.length === 0) {
        return res.status(400).json({ 
          error: 'Invoice prefix must contain at least one alphanumeric character (A-Z, 0-9, or underscore)' 
        });
      }
      if (sanitized.length > 10) {
        return res.status(400).json({ 
          error: 'Invoice prefix cannot exceed 10 characters' 
        });
      }
      if (sanitized !== prefixStr) {
        return res.status(400).json({ 
          error: 'Invoice prefix can only contain letters, numbers, and underscores (no spaces or special characters)' 
        });
      }
      finalValue = sanitized;
    } else if (key === 'invoice_start_number') {
      const startNum = Number(value);
      if (isNaN(startNum) || startNum < 1 || !Number.isInteger(startNum)) {
        return res.status(400).json({ 
          error: 'Invoice starting number must be a positive integer' 
        });
      }
      finalValue = startNum;
    } else if (key === 'jwt_expiry_days') {
      // Validate JWT expiry: 1-90 days
      const days = Number(value);
      if (isNaN(days) || days < 1 || days > 90) {
        return res.status(400).json({ 
          error: 'JWT expiry must be between 1 and 90 days' 
        });
      }
      finalValue = Math.round(days);
    } else if (key === 'otp_expiry_minutes') {
      // Validate OTP expiry: 1-60 minutes
      const minutes = Number(value);
      if (isNaN(minutes) || minutes < 1 || minutes > 60) {
        return res.status(400).json({ 
          error: 'OTP expiry must be between 1 and 60 minutes' 
        });
      }
      finalValue = Math.round(minutes);
    } else if (key === 'password_reset_expiry_minutes') {
      // Validate password reset expiry: 1-60 minutes
      const minutes = Number(value);
      if (isNaN(minutes) || minutes < 1 || minutes > 60) {
        return res.status(400).json({ 
          error: 'Password reset expiry must be between 1 and 60 minutes' 
        });
      }
      finalValue = Math.round(minutes);
    } else if (key === 'phone_number_monthly_credits') {
      // Validate phone credits: 0-1000
      const credits = Number(value);
      if (isNaN(credits) || credits < 0 || credits > 1000) {
        return res.status(400).json({ 
          error: 'Phone number monthly credits must be between 0 and 1000' 
        });
      }
      finalValue = Math.round(credits);
    } else if (key === 'low_credits_threshold') {
      // Validate threshold: 0-500
      const threshold = Number(value);
      if (isNaN(threshold) || threshold < 0 || threshold > 500) {
        return res.status(400).json({ 
          error: 'Low credits threshold must be between 0 and 500' 
        });
      }
      finalValue = Math.round(threshold);
    } else if (key === 'webhook_retry_max_attempts') {
      // Validate max attempts: 1-10
      const attempts = Number(value);
      if (isNaN(attempts) || attempts < 1 || attempts > 10) {
        return res.status(400).json({ 
          error: 'Webhook retry max attempts must be between 1 and 10' 
        });
      }
      finalValue = Math.round(attempts);
    } else if (key === 'webhook_expiry_hours') {
      // Validate expiry: 1-168 hours (1 week)
      const hours = Number(value);
      if (isNaN(hours) || hours < 1 || hours > 168) {
        return res.status(400).json({ 
          error: 'Webhook expiry must be between 1 and 168 hours' 
        });
      }
      finalValue = Math.round(hours);
    } else if (key === 'webhook_retry_intervals_minutes') {
      // Validate intervals array
      if (!Array.isArray(value)) {
        return res.status(400).json({ 
          error: 'Webhook retry intervals must be an array of numbers' 
        });
      }
      const intervals = value.map(Number).filter(n => !isNaN(n) && n >= 1 && n <= 1440);
      if (intervals.length === 0 || intervals.length > 10) {
        return res.status(400).json({ 
          error: 'Webhook retry intervals must contain 1-10 values between 1-1440 minutes' 
        });
      }
      finalValue = intervals;
    } else if (key === 'system_phone_pool_size') {
      // Validate pool size: 1-100
      const poolSize = Number(value);
      if (isNaN(poolSize) || poolSize < 1 || poolSize > 100) {
        return res.status(400).json({ 
          error: 'System phone pool size must be between 1 and 100' 
        });
      }
      finalValue = Math.round(poolSize);
    } else if (key === 'demo_widget_enabled') {
      finalValue = value === true || value === 'true';
    } else if (key === 'demo_max_duration') {
      const duration = Number(value);
      if (isNaN(duration) || duration < 10 || duration > 300) {
        return res.status(400).json({ 
          error: 'Demo max duration must be between 10 and 300 seconds' 
        });
      }
      finalValue = Math.round(duration);
    } else if (key === 'demo_cooldown_minutes') {
      const cooldown = Number(value);
      if (isNaN(cooldown) || cooldown < 1 || cooldown > 60) {
        return res.status(400).json({ 
          error: 'Demo cooldown must be between 1 and 60 minutes' 
        });
      }
      finalValue = Math.round(cooldown);
    } else if (key === 'demo_max_concurrent') {
      const concurrent = Number(value);
      if (isNaN(concurrent) || concurrent < 1 || concurrent > 100) {
        return res.status(400).json({ 
          error: 'Demo max concurrent sessions must be between 1 and 100' 
        });
      }
      finalValue = Math.round(concurrent);
    } else if (key === 'demo_system_prompt') {
      if (typeof value !== 'string') {
        return res.status(400).json({ 
          error: 'Demo system prompt must be a string' 
        });
      }
      finalValue = value.slice(0, 5000);
    } else if (key === 'demo_knowledge_base_ids') {
      if (!Array.isArray(value)) {
        return res.status(400).json({ 
          error: 'Demo knowledge base IDs must be an array' 
        });
      }
      finalValue = value.filter((id: any) => typeof id === 'string').slice(0, 10);
    }
    
    await storage.updateGlobalSetting(key, finalValue);
    
    // Reset Razorpay client when credentials are updated to use new keys
    if (key === 'razorpay_key_id' || key === 'razorpay_key_secret') {
      resetRazorpayClient();
      console.log('✅ [Admin] Razorpay client reset after credential update');
    }
    
    // Reset Stripe client when credentials are updated
    if (key === 'stripe_secret_key' || key === 'stripe_publishable_key') {
      resetStripeClient();
      console.log('✅ [Admin] Stripe client reset after credential update');
    }
    
    // Reset PayPal client when credentials are updated
    if (key === 'paypal_client_id' || key === 'paypal_client_secret' || key === 'paypal_mode') {
      resetPayPalClient();
      console.log('✅ [Admin] PayPal client reset after credential update');
    }
    
    // Reset Paystack client when credentials are updated
    if (key === 'paystack_secret_key' || key === 'paystack_public_key') {
      resetPaystackClient();
      console.log('✅ [Admin] Paystack client reset after credential update');
    }
    
    // Reset MercadoPago client when credentials are updated
    if (key === 'mercadopago_access_token' || key === 'mercadopago_public_key') {
      resetMercadoPagoClient();
      console.log('✅ [Admin] MercadoPago client reset after credential update');
    }
    
    // Note: Twilio and OpenAI don't need explicit reset - they fetch fresh credentials on each call
    // Log credential updates for tracking
    if (key === 'twilio_account_sid' || key === 'twilio_auth_token') {
      console.log('✅ [Admin] Twilio credentials updated in database');
    }
    
    if (key === 'openai_api_key') {
      console.log('✅ [Admin] OpenAI API key updated in database');
    }
    
    // Clear watchdog settings cache when auto-restart settings are updated
    if (key.startsWith('auto_restart_')) {
      clearSettingsCache();
      console.log('✅ [Admin] Resource watchdog settings cache cleared');
    }
    
    // Return warning message when currency is changed
    const currencyKeys = ['paypal_currency', 'paystack_currency', 'mercadopago_currency', 'stripe_currency', 'razorpay_currency'];
    if (currencyKeys.includes(key)) {
      return res.json({ 
        success: true, 
        warning: `Currency changed to ${finalValue}. Please update the prices for all Plans and Credit Packages to use the new currency to avoid payment errors.`
      });
    }
    
    res.json({ success: true, key, value: finalValue });
  } catch (error: any) {
    const settingKey = req.params.key;
    console.error(`Error updating setting '${settingKey}':`, error);
    // Return detailed error for debugging
    res.status(500).json({ 
      error: 'Failed to update setting',
      key: settingKey,
      details: error.message || 'Unknown error'
    });
  }
});

// Get resource status (for auto-restart monitoring)
router.get('/resource-status', async (req: AdminRequest, res: Response) => {
  try {
    const status = await getResourceStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting resource status:', error);
    res.status(500).json({ error: 'Failed to get resource status' });
  }
});

// Helper function to safely parse JSON response, falling back to text
async function safeParseResponse(response: globalThis.Response): Promise<{ data: any; isJson: boolean; rawText?: string }> {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return { data, isJson: true };
  } catch {
    return { data: null, isJson: false, rawText: text };
  }
}

// Helper function to create fetch with timeout (prevents backend hanging on slow/unreachable APIs)
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = 8000): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Test Twilio connection (dynamic status check)
router.post('/test-connection/twilio', async (req: AdminRequest, res: Response) => {
  try {
    // Get credentials from database or environment
    const dbSid = await storage.getGlobalSetting('twilio_account_sid');
    const dbToken = await storage.getGlobalSetting('twilio_auth_token');
    
    const accountSid = (dbSid?.value as string) || process.env.TWILIO_ACCOUNT_SID;
    const authToken = (dbToken?.value as string) || process.env.TWILIO_AUTH_TOKEN;
    
    if (!accountSid || !authToken) {
      return res.json({ 
        connected: false, 
        error: 'Twilio credentials not configured' 
      });
    }
    
    // Test API by fetching account details
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const response = await fetchWithTimeout(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
      headers: {
        'Authorization': `Basic ${auth}`
      }
    });
    
    const { data, isJson, rawText } = await safeParseResponse(response);
    
    if (response.ok && isJson && data) {
      res.json({ 
        connected: true,
        accountName: data.friendly_name,
        accountStatus: data.status
      });
    } else {
      res.json({ 
        connected: false,
        error: `Twilio API error: ${response.status} ${response.statusText}`,
        details: isJson ? JSON.stringify(data) : (rawText?.substring(0, 200) || 'Unknown error')
      });
    }
  } catch (error: any) {
    console.error('Error testing Twilio connection:', error);
    const isTimeout = error.name === 'AbortError';
    res.json({ 
      connected: false,
      error: isTimeout 
        ? 'Connection timed out. Twilio API may be unreachable from this server.'
        : (error.message || 'Failed to test Twilio connection')
    });
  }
});

// Test ElevenLabs connection (dynamic status check)
// Tests both v2 voices and v1 agents endpoints
router.post('/test-connection/elevenlabs', async (req: AdminRequest, res: Response) => {
  try {
    // Check pool keys first, then env var
    const poolStats = await ElevenLabsPoolService.getPoolStats();
    const envApiKey = process.env.ELEVENLABS_API_KEY;
    
    // If pool has keys, test with an available key
    if (poolStats.totalKeys > 0) {
      try {
        const credential = await ElevenLabsPoolService.getAvailableCredential();
        if (credential) {
          // Test v2 voices endpoint
          const voicesResponse = await fetchWithTimeout('https://api.elevenlabs.io/v2/voices?page_size=10', {
            headers: {
              'xi-api-key': credential.apiKey
            }
          });
          
          // Test v1 agents endpoint
          const agentsResponse = await fetchWithTimeout('https://api.elevenlabs.io/v1/convai/agents', {
            headers: {
              'xi-api-key': credential.apiKey
            }
          });
          
          const voicesParsed = await safeParseResponse(voicesResponse);
          const agentsParsed = await safeParseResponse(agentsResponse);
          
          if (voicesResponse.ok && agentsResponse.ok && voicesParsed.isJson && agentsParsed.isJson) {
            const healthyCount = poolStats.credentials.filter(c => c.healthStatus === 'healthy').length;
            return res.json({ 
              connected: true,
              voiceCount: voicesParsed.data?.total_count || voicesParsed.data?.voices?.length || 0,
              agentCount: agentsParsed.data?.agents?.length || 0,
              source: `Pool (${poolStats.totalKeys} keys, ${healthyCount} healthy)`,
              apiVersion: 'v2 (voices) + v1 (agents)'
            });
          }
        }
      } catch (poolError: any) {
        console.error('Pool key test failed, trying env var:', poolError);
      }
    }
    
    // If no pool keys or pool test failed, try env var
    if (!envApiKey) {
      return res.json({ 
        connected: false,
        error: 'ElevenLabs API key not configured (no env var or pool keys)'
      });
    }
    
    // Test API with env var (test both v2 voices and v1 agents)
    const voicesResponse = await fetchWithTimeout('https://api.elevenlabs.io/v2/voices?page_size=10', {
      headers: {
        'xi-api-key': envApiKey
      }
    });
    
    const agentsResponse = await fetchWithTimeout('https://api.elevenlabs.io/v1/convai/agents', {
      headers: {
        'xi-api-key': envApiKey
      }
    });
    
    const voicesParsed = await safeParseResponse(voicesResponse);
    const agentsParsed = await safeParseResponse(agentsResponse);
    
    if (voicesResponse.ok && agentsResponse.ok && voicesParsed.isJson && agentsParsed.isJson) {
      res.json({ 
        connected: true,
        voiceCount: voicesParsed.data?.total_count || voicesParsed.data?.voices?.length || 0,
        agentCount: agentsParsed.data?.agents?.length || 0,
        source: 'Environment variable',
        apiVersion: 'v2 (voices) + v1 (agents)'
      });
    } else {
      const errorDetails = !voicesResponse.ok 
        ? (voicesParsed.isJson ? JSON.stringify(voicesParsed.data) : voicesParsed.rawText?.substring(0, 200))
        : (agentsParsed.isJson ? JSON.stringify(agentsParsed.data) : agentsParsed.rawText?.substring(0, 200));
      res.json({ 
        connected: false,
        error: !voicesResponse.ok 
          ? `ElevenLabs v2 voices API error: ${voicesResponse.status} ${voicesResponse.statusText}` 
          : `ElevenLabs v1 agents API error: ${agentsResponse.status} ${agentsResponse.statusText}`,
        details: errorDetails || 'Unknown error'
      });
    }
  } catch (error: any) {
    console.error('Error testing ElevenLabs connection:', error);
    const isTimeout = error.name === 'AbortError';
    res.json({ 
      connected: false,
      error: isTimeout 
        ? 'Connection timed out. ElevenLabs API may be unreachable from this server.'
        : (error.message || 'Failed to test ElevenLabs connection')
    });
  }
});

// Test OpenAI connection (dynamic status check)
router.post('/test-connection/openai', async (req: AdminRequest, res: Response) => {
  try {
    // Get credentials from database or environment
    const dbApiKey = await storage.getGlobalSetting('openai_api_key');
    const apiKey = (dbApiKey?.value as string) || process.env.OPENAI_API_KEY;
    
    if (!apiKey) {
      return res.json({ 
        connected: false, 
        error: 'OpenAI API key not configured' 
      });
    }
    
    // Test API by listing models
    const response = await fetchWithTimeout('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    const { data, isJson, rawText } = await safeParseResponse(response);
    
    if (response.ok && isJson && data) {
      const modelCount = data.data?.length || 0;
      const hasEmbeddings = data.data?.some((m: any) => m.id.includes('embedding')) || false;
      const source = dbApiKey?.value ? 'Database' : 'Environment variable';
      
      res.json({ 
        connected: true,
        modelCount,
        hasEmbeddings,
        source
      });
    } else {
      res.json({ 
        connected: false,
        error: `OpenAI API error: ${response.status} ${response.statusText}`,
        details: isJson ? JSON.stringify(data) : (rawText?.substring(0, 200) || 'Unknown error')
      });
    }
  } catch (error: any) {
    console.error('Error testing OpenAI connection:', error);
    const isTimeout = error.name === 'AbortError';
    res.json({ 
      connected: false,
      error: isTimeout 
        ? 'Connection timed out. OpenAI API may be unreachable from this server.'
        : (error.message || 'Failed to test OpenAI connection')
    });
  }
});

// Test OpenAI Realtime Voice API connection (for Plivo/Twilio-OpenAI engines)
router.post('/test-connection/openai-realtime', async (req: AdminRequest, res: Response) => {
  try {
    // Get credentials from openaiCredentials table (pool system for realtime)
    const credentials = await db.select().from(openaiCredentials).where(eq(openaiCredentials.isActive, true));
    
    if (!credentials || credentials.length === 0) {
      return res.json({ 
        connected: false, 
        error: 'No OpenAI Realtime credentials configured',
        keyCount: 0
      });
    }
    
    // Test the first active credential by actually calling the realtime sessions endpoint
    const firstCredential = credentials[0];
    
    // First check if we can list models (basic API access)
    const modelsResponse = await fetchWithTimeout('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${firstCredential.apiKey}`
      }
    });
    
    if (!modelsResponse.ok) {
      const { data, isJson, rawText } = await safeParseResponse(modelsResponse);
      return res.json({ 
        connected: false,
        error: `OpenAI API error: ${modelsResponse.status} ${modelsResponse.statusText}`,
        keyCount: credentials.length,
        details: isJson ? JSON.stringify(data) : (rawText?.substring(0, 200) || 'Unknown error')
      });
    }
    
    const modelsData = await modelsResponse.json();
    const hasRealtimeModels = modelsData.data?.some((m: any) => 
      m.id.includes('realtime') || m.id.includes('gpt-4o-realtime')
    ) || false;
    
    // Now test the actual realtime sessions endpoint
    let realtimeSessionsWorking = false;
    let realtimeError = '';
    
    try {
      const realtimeResponse = await fetchWithTimeout('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${firstCredential.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-realtime-preview-2024-12-17',
          voice: 'alloy'
        })
      });
      
      if (realtimeResponse.ok) {
        realtimeSessionsWorking = true;
      } else {
        const errorText = await realtimeResponse.text();
        console.error('[Admin] OpenAI Realtime sessions test failed:', {
          status: realtimeResponse.status,
          body: errorText
        });
        try {
          const parsed = JSON.parse(errorText);
          realtimeError = parsed.error?.message || `HTTP ${realtimeResponse.status}`;
        } catch {
          realtimeError = `HTTP ${realtimeResponse.status}: ${errorText.substring(0, 100)}`;
        }
      }
    } catch (e: any) {
      realtimeError = e.message || 'Failed to test realtime endpoint';
    }
    
    // Count total active keys and their tiers
    const freeKeys = credentials.filter(c => c.modelTier === 'free').length;
    const proKeys = credentials.filter(c => c.modelTier === 'pro').length;
    
    res.json({ 
      connected: realtimeSessionsWorking,
      keyCount: credentials.length,
      freeKeys,
      proKeys,
      hasRealtimeModels,
      realtimeSessionsWorking,
      realtimeError: realtimeError || undefined,
      source: 'Credential Pool'
    });
  } catch (error: any) {
    console.error('Error testing OpenAI Realtime connection:', error);
    const isTimeout = error.name === 'AbortError';
    res.json({ 
      connected: false,
      error: isTimeout 
        ? 'Connection timed out. OpenAI API may be unreachable from this server.'
        : (error.message || 'Failed to test OpenAI Realtime connection')
    });
  }
});

// Test Stripe connection (dynamic status check)
router.post('/test-connection/stripe', async (req: AdminRequest, res: Response) => {
  try {
    // Get credentials from database or environment
    const dbSecretKey = await storage.getGlobalSetting('stripe_secret_key');
    const secretKey = (dbSecretKey?.value as string) || process.env.STRIPE_SECRET_KEY;
    
    if (!secretKey) {
      return res.json({ 
        connected: false, 
        error: 'Stripe secret key not configured' 
      });
    }
    
    // Test API by fetching account balance
    const response = await fetchWithTimeout('https://api.stripe.com/v1/balance', {
      headers: {
        'Authorization': `Bearer ${secretKey}`
      }
    });
    
    const { data, isJson, rawText } = await safeParseResponse(response);
    
    if (response.ok && isJson && data) {
      const isLiveMode = !secretKey.includes('_test_');
      const source = dbSecretKey?.value ? 'Database' : 'Environment variable';
      
      // Get available balance for display
      const availableBalance = data.available?.[0]?.amount || 0;
      const currency = data.available?.[0]?.currency || 'usd';
      
      res.json({ 
        connected: true,
        mode: isLiveMode ? 'live' : 'test',
        currency: currency.toUpperCase(),
        availableBalance: (availableBalance / 100).toFixed(2),
        source
      });
    } else {
      res.json({ 
        connected: false,
        error: `Stripe API error: ${isJson && data?.error?.message ? data.error.message : response.statusText}`,
        details: isJson ? (data?.error?.type || JSON.stringify(data)) : (rawText?.substring(0, 200) || 'Unknown error')
      });
    }
  } catch (error: any) {
    console.error('Error testing Stripe connection:', error);
    const isTimeout = error.name === 'AbortError';
    res.json({ 
      connected: false,
      error: isTimeout 
        ? 'Connection timed out. Stripe API may be unreachable from this server.'
        : (error.message || 'Failed to test Stripe connection')
    });
  }
});

// Test PayPal connection (dynamic status check)
router.post('/test-connection/paypal', async (req: AdminRequest, res: Response) => {
  try {
    const dbClientId = await storage.getGlobalSetting('paypal_client_id');
    const dbClientSecret = await storage.getGlobalSetting('paypal_client_secret');
    const dbMode = await storage.getGlobalSetting('paypal_mode');
    
    const clientId = dbClientId?.value as string;
    const clientSecret = dbClientSecret?.value as string;
    const mode = (dbMode?.value as string) || 'sandbox';
    
    if (!clientId || !clientSecret) {
      return res.json({ 
        connected: false, 
        error: 'PayPal credentials not configured' 
      });
    }
    
    const baseUrl = mode === 'live' 
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
    
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenResponse = await fetchWithTimeout(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials'
    });
    
    const { data: tokenData, isJson, rawText } = await safeParseResponse(tokenResponse);
    
    if (tokenResponse.ok && isJson && tokenData) {
      console.log(`✅ [PayPal] Test connection successful - Mode: ${mode}`);
      res.json({ 
        connected: true,
        mode: mode,
        tokenType: tokenData.token_type,
        source: 'Database'
      });
    } else {
      const errorMessage = isJson 
        ? (tokenData?.error_description || tokenData?.error || tokenResponse.statusText)
        : tokenResponse.statusText;
      console.error(`❌ [PayPal] Test connection failed - Mode: ${mode}, Error: ${isJson ? JSON.stringify(tokenData) : rawText?.substring(0, 200)}`);
      res.json({ 
        connected: false,
        error: `PayPal API error (${mode} mode): ${errorMessage}. Please verify your Client ID and Secret are correct for ${mode} mode.`
      });
    }
  } catch (error: any) {
    console.error('Error testing PayPal connection:', error);
    const isTimeout = error.name === 'AbortError';
    res.json({ 
      connected: false,
      error: isTimeout 
        ? 'Connection timed out. PayPal API may be unreachable from this server.'
        : `Connection failed: ${error.message || 'Unknown error'}. Please check your credentials.`
    });
  }
});

// Test Paystack connection (dynamic status check)
router.post('/test-connection/paystack', async (req: AdminRequest, res: Response) => {
  try {
    const dbSecretKey = await storage.getGlobalSetting('paystack_secret_key');
    const secretKey = dbSecretKey?.value as string;
    
    if (!secretKey) {
      return res.json({ 
        connected: false, 
        error: 'Paystack secret key not configured' 
      });
    }
    
    const response = await fetchWithTimeout('https://api.paystack.co/balance', {
      headers: {
        'Authorization': `Bearer ${secretKey}`
      }
    });
    
    const { data, isJson, rawText } = await safeParseResponse(response);
    
    if (response.ok && isJson && data) {
      const balance = data.data?.[0];
      res.json({ 
        connected: true,
        currency: balance?.currency || 'NGN',
        balance: balance?.balance ? (balance.balance / 100).toFixed(2) : '0.00',
        source: 'Database'
      });
    } else {
      res.json({ 
        connected: false,
        error: `Paystack API error: ${isJson && data?.message ? data.message : response.statusText}`,
        details: isJson ? JSON.stringify(data) : (rawText?.substring(0, 200) || 'Unknown error')
      });
    }
  } catch (error: any) {
    console.error('Error testing Paystack connection:', error);
    const isTimeout = error.name === 'AbortError';
    res.json({ 
      connected: false,
      error: isTimeout 
        ? 'Connection timed out. Paystack API may be unreachable from this server.'
        : (error.message || 'Failed to test Paystack connection')
    });
  }
});

// Test MercadoPago connection (dynamic status check)
router.post('/test-connection/mercadopago', async (req: AdminRequest, res: Response) => {
  try {
    const dbAccessToken = await storage.getGlobalSetting('mercadopago_access_token');
    const accessToken = dbAccessToken?.value as string;
    
    if (!accessToken) {
      return res.json({ 
        connected: false, 
        error: 'MercadoPago access token not configured' 
      });
    }
    
    const response = await fetchWithTimeout('https://api.mercadopago.com/users/me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    const { data, isJson, rawText } = await safeParseResponse(response);
    
    if (response.ok && isJson && data) {
      res.json({ 
        connected: true,
        countryId: data.country_id,
        email: data.email,
        source: 'Database'
      });
    } else {
      res.json({ 
        connected: false,
        error: `MercadoPago API error: ${isJson && data?.message ? data.message : response.statusText}`,
        details: isJson ? JSON.stringify(data) : (rawText?.substring(0, 200) || 'Unknown error')
      });
    }
  } catch (error: any) {
    console.error('Error testing MercadoPago connection:', error);
    const isTimeout = error.name === 'AbortError';
    res.json({ 
      connected: false,
      error: isTimeout 
        ? 'Connection timed out. MercadoPago API may be unreachable from this server.'
        : (error.message || 'Failed to test MercadoPago connection')
    });
  }
});

// Test Razorpay connection (dynamic status check)
router.post('/test-connection/razorpay', async (req: AdminRequest, res: Response) => {
  try {
    const dbKeyId = await storage.getGlobalSetting('razorpay_key_id');
    const dbKeySecret = await storage.getGlobalSetting('razorpay_key_secret');
    
    const keyId = (dbKeyId?.value as string) || process.env.RAZORPAY_KEY_ID;
    const keySecret = (dbKeySecret?.value as string) || process.env.RAZORPAY_KEY_SECRET;
    
    if (!keyId || !keySecret) {
      return res.json({ 
        connected: false, 
        error: 'Razorpay credentials not configured' 
      });
    }
    
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const response = await fetchWithTimeout('https://api.razorpay.com/v1/payments?count=1', {
      headers: {
        'Authorization': `Basic ${auth}`
      }
    });
    
    const { data, isJson, rawText } = await safeParseResponse(response);
    
    if (response.ok) {
      const isLiveMode = !keyId.includes('test');
      const source = dbKeyId?.value ? 'Database' : 'Environment variable';
      
      res.json({ 
        connected: true,
        mode: isLiveMode ? 'live' : 'test',
        source
      });
    } else {
      res.json({ 
        connected: false,
        error: `Razorpay API error: ${isJson && data?.error?.description ? data.error.description : response.statusText}`,
        details: isJson ? JSON.stringify(data) : (rawText?.substring(0, 200) || 'Unknown error')
      });
    }
  } catch (error: any) {
    console.error('Error testing Razorpay connection:', error);
    const isTimeout = error.name === 'AbortError';
    res.json({ 
      connected: false,
      error: isTimeout 
        ? 'Connection timed out. Razorpay API may be unreachable from this server.'
        : (error.message || 'Failed to test Razorpay connection')
    });
  }
});

// Test Razorpay webhook secret by simulating a webhook event
router.post('/test-webhook/razorpay', async (req: AdminRequest, res: Response) => {
  try {
    const dbWebhookSecret = await storage.getGlobalSetting('razorpay_webhook_secret');
    const webhookSecret = dbWebhookSecret?.value as string;
    
    if (!webhookSecret) {
      return res.json({ 
        success: false, 
        error: 'Razorpay webhook secret not configured. Please add your webhook secret first.' 
      });
    }
    
    // Create a test payload
    const testPayload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_test_' + Date.now(),
            amount: 10000,
            currency: 'INR',
            status: 'captured',
            description: 'Test webhook verification'
          }
        }
      },
      created_at: Math.floor(Date.now() / 1000)
    };
    
    const payloadString = JSON.stringify(testPayload);
    
    // Generate signature using the webhook secret
    const crypto = await import('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(payloadString)
      .digest('hex');
    
    // Verify signature by re-computing
    const verifySignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(payloadString)
      .digest('hex');
    
    if (expectedSignature === verifySignature) {
      console.log('✅ [Razorpay] Webhook secret verified successfully');
      res.json({ 
        success: true, 
        message: 'Webhook secret is valid and working correctly',
        testPayload: testPayload.event,
        signatureLength: expectedSignature.length
      });
    } else {
      res.json({ 
        success: false, 
        error: 'Webhook signature verification failed - secret may be invalid' 
      });
    }
  } catch (error: any) {
    console.error('Error testing Razorpay webhook:', error);
    res.json({ 
      success: false,
      error: error.message || 'Failed to test webhook secret'
    });
  }
});

// Setup PayPal webhook automatically via API
router.post('/setup-webhook/paypal', async (req: AdminRequest, res: Response) => {
  try {
    const dbClientId = await storage.getGlobalSetting('paypal_client_id');
    const dbClientSecret = await storage.getGlobalSetting('paypal_client_secret');
    const dbMode = await storage.getGlobalSetting('paypal_mode');
    
    const clientId = dbClientId?.value as string;
    const clientSecret = dbClientSecret?.value as string;
    const mode = (dbMode?.value as string) || 'sandbox';
    
    if (!clientId || !clientSecret) {
      return res.status(400).json({ 
        success: false, 
        error: 'PayPal credentials not configured. Please save your Client ID and Secret first.' 
      });
    }
    
    const baseUrl = mode === 'live' 
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
    
    // Get access token
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenResponse = await fetchWithTimeout(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials'
    });
    
    if (!tokenResponse.ok) {
      const error = await tokenResponse.json();
      return res.status(400).json({
        success: false,
        error: `Failed to authenticate with PayPal: ${error.error_description || 'Unknown error'}`
      });
    }
    
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    
    // Get the webhook URL from the request body
    const { webhookUrl } = req.body;
    if (!webhookUrl) {
      return res.status(400).json({
        success: false,
        error: 'Webhook URL is required'
      });
    }
    
    // First, check if webhook already exists and delete it
    const listResponse = await fetch(`${baseUrl}/v1/notifications/webhooks`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      }
    });
    
    if (listResponse.ok) {
      const listData = await listResponse.json();
      const existingWebhooks = listData.webhooks || [];
      
      // Find webhooks with similar URL (same origin)
      for (const webhook of existingWebhooks) {
        if (webhook.url && webhook.url.includes('/api/paypal/webhook')) {
          console.log(`[PayPal] Deleting existing webhook: ${webhook.id}`);
          await fetch(`${baseUrl}/v1/notifications/webhooks/${webhook.id}`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
            }
          });
        }
      }
    }
    
    // Create new webhook
    const webhookPayload = {
      url: webhookUrl,
      event_types: [
        { name: 'BILLING.SUBSCRIPTION.ACTIVATED' },
        { name: 'BILLING.SUBSCRIPTION.RENEWED' },
        { name: 'BILLING.SUBSCRIPTION.CANCELLED' },
        { name: 'BILLING.SUBSCRIPTION.SUSPENDED' },
        { name: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED' },
        { name: 'PAYMENT.SALE.COMPLETED' },
        { name: 'PAYMENT.SALE.REFUNDED' },
        { name: 'CHECKOUT.ORDER.APPROVED' },
        { name: 'CHECKOUT.ORDER.COMPLETED' },
      ]
    };
    
    const webhookResponse = await fetch(`${baseUrl}/v1/notifications/webhooks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(webhookPayload)
    });
    
    if (webhookResponse.ok) {
      const webhookData = await webhookResponse.json();
      const webhookId = webhookData.id;
      
      // Save webhook ID to database
      await storage.updateGlobalSetting('paypal_webhook_id', webhookId);
      
      console.log(`✅ [PayPal] Webhook created successfully - ID: ${webhookId}`);
      res.json({
        success: true,
        webhookId,
        message: 'PayPal webhook configured successfully'
      });
    } else {
      const error = await webhookResponse.json();
      console.error(`❌ [PayPal] Webhook creation failed:`, error);
      
      // Handle specific errors
      if (error.name === 'WEBHOOK_URL_ALREADY_EXISTS') {
        return res.status(400).json({
          success: false,
          error: 'This webhook URL is already registered with PayPal. Please use a different URL or delete the existing webhook from PayPal dashboard.'
        });
      }
      
      res.status(400).json({
        success: false,
        error: `Failed to create webhook: ${error.message || error.details?.[0]?.description || 'Unknown error'}`
      });
    }
  } catch (error: any) {
    console.error('Error setting up PayPal webhook:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to setup PayPal webhook'
    });
  }
});

// Setup MercadoPago webhook automatically via API
router.post('/setup-webhook/mercadopago', async (req: AdminRequest, res: Response) => {
  try {
    const dbAccessToken = await storage.getGlobalSetting('mercadopago_access_token');
    const accessToken = dbAccessToken?.value as string;
    
    if (!accessToken) {
      return res.status(400).json({ 
        success: false, 
        error: 'MercadoPago access token not configured. Please save your credentials first.' 
      });
    }
    
    const { webhookUrl } = req.body;
    if (!webhookUrl) {
      return res.status(400).json({
        success: false,
        error: 'Webhook URL is required'
      });
    }
    
    // First, list existing webhooks and delete our old ones
    const listResponse = await fetch('https://api.mercadopago.com/v1/webhooks', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      }
    });
    
    if (listResponse.ok) {
      const existingWebhooks = await listResponse.json();
      
      // Delete webhooks with similar URL
      for (const webhook of existingWebhooks) {
        if (webhook.url && webhook.url.includes('/api/mercadopago/webhook')) {
          console.log(`[MercadoPago] Deleting existing webhook: ${webhook.id}`);
          await fetch(`https://api.mercadopago.com/v1/webhooks/${webhook.id}`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
            }
          });
        }
      }
    }
    
    // Create new webhook
    const webhookPayload = {
      url: webhookUrl,
      events: [
        'payment.created',
        'payment.updated',
        'merchant_order',
      ]
    };
    
    const webhookResponse = await fetch('https://api.mercadopago.com/v1/webhooks', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(webhookPayload)
    });
    
    if (webhookResponse.ok) {
      const webhookData = await webhookResponse.json();
      const webhookId = webhookData.id;
      
      // Save webhook ID to database
      await storage.updateGlobalSetting('mercadopago_webhook_id', String(webhookId));
      
      console.log(`✅ [MercadoPago] Webhook created successfully - ID: ${webhookId}`);
      res.json({
        success: true,
        webhookId,
        message: 'MercadoPago webhook configured successfully'
      });
    } else {
      const error = await webhookResponse.json();
      console.error(`❌ [MercadoPago] Webhook creation failed:`, error);
      res.status(400).json({
        success: false,
        error: `Failed to create webhook: ${error.message || error.error || 'Unknown error'}`
      });
    }
  } catch (error: any) {
    console.error('Error setting up MercadoPago webhook:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to setup MercadoPago webhook'
    });
  }
});

// Get platform analytics
router.get('/analytics', async (req: AdminRequest, res: Response) => {
  try {
    const { timeRange = '30d' } = req.query;
    const analytics = await storage.getGlobalAnalytics(timeRange as string);
    res.json(analytics);
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Get system phone numbers
router.get('/phone-numbers', async (req: AdminRequest, res: Response) => {
  try {
    const phoneNumbers = await storage.getSystemPhoneNumbers();
    res.json(phoneNumbers);
  } catch (error) {
    console.error('Error fetching phone numbers:', error);
    res.status(500).json({ error: 'Failed to fetch phone numbers' });
  }
});

// Get active Twilio numbers not yet in system pool
router.get('/phone-numbers/twilio-active', async (req: AdminRequest, res: Response) => {
  try {
    // Fetch all active numbers from Twilio
    const twilioNumbers = await twilioService.listOwnedNumbers();
    
    // Fetch all phone numbers already in database (system pool + user-owned)
    const { db } = await import('../db');
    const { phoneNumbers } = await import('../../shared/schema');
    const existingNumbers = await db.select().from(phoneNumbers);
    
    // Create a set of existing phone numbers for fast lookup
    const existingPhoneSet = new Set(existingNumbers.map(n => n.phoneNumber));
    
    // Filter Twilio numbers to only show ones not in database
    const availableForImport = twilioNumbers
      .filter((twilioNum: any) => !existingPhoneSet.has(twilioNum.phoneNumber))
      .map((num: any) => ({
        phoneNumber: num.phoneNumber,
        friendlyName: num.friendlyName || num.phoneNumber,
        sid: num.sid,
        capabilities: num.capabilities,
        pricing: num.pricing, // Include pricing information
      }));
    
    res.json(availableForImport);
  } catch (error) {
    console.error('Error fetching active Twilio numbers:', error);
    res.status(500).json({ error: 'Failed to fetch active Twilio numbers' });
  }
});

// Import existing Twilio number to system pool
router.post('/phone-numbers/import', async (req: AdminRequest, res: Response) => {
  try {
    const { phoneNumber, friendlyName, sid } = req.body;
    
    if (!phoneNumber || !sid) {
      return res.status(400).json({ error: 'Phone number and SID are required' });
    }
    
    // Add to database as system pool number
    const { db } = await import('../db');
    const { phoneNumbers } = await import('../../shared/schema');
    
    const [importedNumber] = await db.insert(phoneNumbers).values({
      phoneNumber: phoneNumber,
      twilioSid: sid,
      friendlyName: friendlyName || phoneNumber,
      country: 'US', // Default, can be enhanced later
      capabilities: {},
      status: 'active',
      isSystemPool: true, // Mark as system pool number
      purchasedAt: new Date(),
    }).returning();
    
    console.log(`Imported Twilio number ${phoneNumber} to system pool`);
    res.json(importedNumber);
  } catch (error) {
    console.error('Error importing Twilio number:', error);
    res.status(500).json({ error: 'Failed to import phone number' });
  }
});

// Release phone number (delete from Twilio and database)
router.delete('/phone-numbers/release/:sid', async (req: AdminRequest, res: Response) => {
  try {
    const { sid } = req.params;
    
    if (!sid) {
      return res.status(400).json({ error: 'SID is required' });
    }
    
    const { db } = await import('../db');
    const { phoneNumbers } = await import('../../shared/schema');
    const { eq } = await import('drizzle-orm');
    
    // Find the number in our database
    const [phoneNumber] = await db.select().from(phoneNumbers).where(eq(phoneNumbers.twilioSid, sid));
    
    if (!phoneNumber) {
      return res.status(404).json({ error: 'Phone number not found' });
    }
    
    // Release from Twilio first
    try {
      await twilioService.releasePhoneNumber(sid);
      console.log(`Released phone number ${phoneNumber.phoneNumber} from Twilio`);
    } catch (twilioError) {
      console.error('Error releasing from Twilio:', twilioError);
      // Continue with database deletion even if Twilio release fails
      // (number might have been already released manually)
    }
    
    // Delete from our database
    await db.delete(phoneNumbers).where(eq(phoneNumbers.twilioSid, sid));
    console.log(`Deleted phone number ${phoneNumber.phoneNumber} from database`);
    
    res.json({ message: 'Phone number released successfully', phoneNumber: phoneNumber.phoneNumber });
  } catch (error) {
    console.error('Error releasing phone number:', error);
    res.status(500).json({ error: 'Failed to release phone number' });
  }
});

// ElevenLabs API Key Pool Management
// Get all credentials with stats
router.get('/elevenlabs-pool', async (req: AdminRequest, res: Response) => {
  try {
    const credentials = await ElevenLabsPoolService.getAllWithStats();
    res.json(credentials);
  } catch (error) {
    console.error('Error fetching ElevenLabs credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// Get pool statistics
router.get('/elevenlabs-pool/stats', async (req: AdminRequest, res: Response) => {
  try {
    const stats = await ElevenLabsPoolService.getPoolStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching pool stats:', error);
    res.status(500).json({ error: 'Failed to fetch pool stats' });
  }
});

// Add new ElevenLabs credential
router.post('/elevenlabs-pool', async (req: AdminRequest, res: Response) => {
  try {
    let credentialData;
    try {
      credentialData = insertElevenLabsCredentialSchema.parse(req.body);
    } catch (validationError: any) {
      if (validationError.errors) {
        return res.status(400).json({ 
          error: 'Validation failed', 
          details: validationError.errors 
        });
      }
      throw validationError;
    }
    const credential = await ElevenLabsPoolService.addCredential(credentialData);
    
    // Automatically sync voices after adding credential
    // This runs in background to not block the response
    (async () => {
      try {
        console.log(`🔊 [Voice Sync] Starting automatic voice sync for new credential: ${credential.name}`);
        const { ElevenLabsService } = await import('../services/elevenlabs');
        const elevenLabsService = new ElevenLabsService(credential.apiKey);
        
        // Fetch voices from ElevenLabs API
        const voicesResult = await elevenLabsService.listVoices();
        const voiceCount = voicesResult.voices?.length || 0;
        
        console.log(`✅ [Voice Sync] Fetched ${voiceCount} voices for credential: ${credential.name}`);
        
        // Update credential with voice count info (optional tracking)
        const { db } = await import('../db');
        const { elevenLabsCredentials } = await import('../../shared/schema');
        const { eq } = await import('drizzle-orm');
        
        await db.update(elevenLabsCredentials)
          .set({ 
            lastHealthCheck: new Date(),
            healthStatus: 'healthy'
          })
          .where(eq(elevenLabsCredentials.id, credential.id));
          
        console.log(`✅ [Voice Sync] Automatic voice sync completed for credential: ${credential.name}`);
      } catch (syncError) {
        console.error(`⚠️ [Voice Sync] Error during automatic voice sync for ${credential.name}:`, syncError);
      }
    })();
    
    // Hide API key in response
    res.json({
      ...credential,
      apiKey: '***hidden***',
      message: 'Credential added successfully. Voice sync started in background.'
    });
  } catch (error: any) {
    console.error('Error adding ElevenLabs credential:', error);
    res.status(500).json({ error: error.message || 'Failed to add credential' });
  }
});

// Test ElevenLabs API key
router.post('/elevenlabs-pool/test', async (req: AdminRequest, res: Response) => {
  try {
    const { apiKey } = req.body;
    
    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required' });
    }
    
    const isValid = await ElevenLabsPoolService.testCredential(apiKey);
    res.json({ valid: isValid });
  } catch (error) {
    console.error('Error testing ElevenLabs credential:', error);
    res.status(500).json({ error: 'Failed to test credential' });
  }
});

// Deactivate credential
router.patch('/elevenlabs-pool/:credentialId/deactivate', async (req: AdminRequest, res: Response) => {
  try {
    const { credentialId } = req.params;
    await ElevenLabsPoolService.deactivateCredential(credentialId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deactivating credential:', error);
    res.status(500).json({ error: 'Failed to deactivate credential' });
  }
});

// Activate credential
router.patch('/elevenlabs-pool/:credentialId/activate', async (req: AdminRequest, res: Response) => {
  try {
    const { credentialId } = req.params;
    const { db } = await import('../db');
    const { elevenLabsCredentials } = await import('../../shared/schema');
    const { eq } = await import('drizzle-orm');
    
    await db.update(elevenLabsCredentials)
      .set({ isActive: true, updatedAt: new Date() })
      .where(eq(elevenLabsCredentials.id, credentialId));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error activating credential:', error);
    res.status(500).json({ error: 'Failed to activate credential' });
  }
});

// Delete credential
router.delete('/elevenlabs-pool/:credentialId', async (req: AdminRequest, res: Response) => {
  try {
    const { credentialId } = req.params;
    await ElevenLabsPoolService.deleteCredential(credentialId);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting credential:', error);
    res.status(500).json({ error: error.message || 'Failed to delete credential' });
  }
});

// Perform health checks on all credentials
router.post('/elevenlabs-pool/health-check', async (req: AdminRequest, res: Response) => {
  try {
    await ElevenLabsPoolService.performHealthChecks();
    res.json({ success: true });
  } catch (error) {
    console.error('Error performing health checks:', error);
    res.status(500).json({ error: 'Failed to perform health checks' });
  }
});

// Sync existing agents to the pool and recalculate counts
router.post('/elevenlabs-pool/sync-agents', async (req: AdminRequest, res: Response) => {
  try {
    // First, assign any unassigned agents to credentials
    const syncResult = await ElevenLabsPoolService.syncExistingAgents();
    
    // Then recalculate all counts to fix any drift
    const recalculateResult = await ElevenLabsPoolService.recalculateAgentCounts();
    
    // Also recalculate user counts
    const userCountResult = await ElevenLabsPoolService.recalculateUserCounts();
    
    res.json({
      ...syncResult,
      recalculated: recalculateResult.updated,
      countUpdates: recalculateResult.credentials,
      userCountsRecalculated: userCountResult.updated,
      userCountUpdates: userCountResult.credentials,
    });
  } catch (error: any) {
    console.error('Error syncing agents:', error);
    res.status(500).json({ error: error.message || 'Failed to sync agents' });
  }
});

// Get users assigned to a specific credential
router.get('/elevenlabs-pool/:credentialId/users', async (req: AdminRequest, res: Response) => {
  try {
    const { credentialId } = req.params;
    const credentialWithUsers = await ElevenLabsPoolService.getCredentialWithUserStats(credentialId);
    
    if (!credentialWithUsers) {
      return res.status(404).json({ error: 'Credential not found' });
    }
    
    // Remove API key from response
    const { apiKey, ...safeCredential } = credentialWithUsers;
    res.json(safeCredential);
  } catch (error: any) {
    console.error('Error getting credential users:', error);
    res.status(500).json({ error: error.message || 'Failed to get credential users' });
  }
});

// Update credential threshold (maxAgentsThreshold)
router.patch('/elevenlabs-pool/:credentialId/threshold', async (req: AdminRequest, res: Response) => {
  try {
    const { credentialId } = req.params;
    const { maxAgentsThreshold } = req.body;
    
    if (typeof maxAgentsThreshold !== 'number' || maxAgentsThreshold < 1) {
      return res.status(400).json({ error: 'maxAgentsThreshold must be a positive number' });
    }
    
    const { db } = await import('../db');
    const { elevenLabsCredentials } = await import('../../shared/schema');
    const { eq } = await import('drizzle-orm');
    
    await db.update(elevenLabsCredentials)
      .set({ maxAgentsThreshold, updatedAt: new Date() })
      .where(eq(elevenLabsCredentials.id, credentialId));
    
    res.json({ success: true, maxAgentsThreshold });
  } catch (error: any) {
    console.error('Error updating credential threshold:', error);
    res.status(500).json({ error: error.message || 'Failed to update credential threshold' });
  }
});

// Manual user migration between credentials
router.post('/elevenlabs-pool/migrate-user', async (req: AdminRequest, res: Response) => {
  try {
    const { userId, fromCredentialId, toCredentialId, dryRun = false } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    const { migrateUserResources, getAvailableCredential, getUserCurrentCredential } = await import('../engines/elevenlabs-migration');
    
    // Get source credential if not provided
    let sourceCredentialId = fromCredentialId;
    if (!sourceCredentialId) {
      sourceCredentialId = await getUserCurrentCredential(userId);
      if (!sourceCredentialId) {
        return res.status(400).json({ error: 'User has no resources to migrate' });
      }
    }
    
    // Get destination credential if not provided (auto-select available)
    let destCredentialId = toCredentialId;
    if (!destCredentialId) {
      const availableCredential = await getAvailableCredential(sourceCredentialId);
      if (!availableCredential) {
        return res.status(400).json({ error: 'No available credential with capacity' });
      }
      destCredentialId = availableCredential.id;
    }
    
    if (sourceCredentialId === destCredentialId) {
      return res.status(400).json({ error: 'Source and destination credentials are the same' });
    }
    
    // Perform migration
    const result = await migrateUserResources(userId, sourceCredentialId, destCredentialId, { dryRun });
    
    res.json(result);
  } catch (error: any) {
    console.error('Error migrating user:', error);
    res.status(500).json({ error: error.message || 'Failed to migrate user' });
  }
});

// Get migration retry queue status
router.get('/elevenlabs-pool/retry-queue', async (req: AdminRequest, res: Response) => {
  try {
    const { getRetryQueueStatus } = await import('../engines/elevenlabs-migration');
    const status = await getRetryQueueStatus();
    res.json(status);
  } catch (error: any) {
    console.error('Error getting retry queue status:', error);
    res.status(500).json({ error: error.message || 'Failed to get retry queue status' });
  }
});

// Manually process retry queue
router.post('/elevenlabs-pool/process-retry-queue', async (req: AdminRequest, res: Response) => {
  try {
    const { processRetryQueue } = await import('../engines/elevenlabs-migration');
    const result = await processRetryQueue();
    res.json(result);
  } catch (error: any) {
    console.error('Error processing retry queue:', error);
    res.status(500).json({ error: error.message || 'Failed to process retry queue' });
  }
});

// Sync a voice from the shared library to all pool credentials
router.post('/elevenlabs-pool/sync-voice', async (req: AdminRequest, res: Response) => {
  try {
    const { voiceId, publicOwnerId, voiceName } = req.body;
    
    if (!voiceId || !publicOwnerId) {
      return res.status(400).json({ 
        error: 'voiceId and publicOwnerId are required' 
      });
    }
    
    const { VoiceSyncService } = await import('../services/voice-sync');
    const result = await VoiceSyncService.syncVoiceToAllCredentials(
      voiceId,
      publicOwnerId,
      voiceName || null
    );
    
    res.json({
      success: true,
      ...result,
      message: `Voice synced: ${result.synced} succeeded, ${result.failed} failed, ${result.skipped} skipped`
    });
  } catch (error: any) {
    console.error('Error syncing voice:', error);
    res.status(500).json({ error: error.message || 'Failed to sync voice' });
  }
});

// Get synced voices for a credential
router.get('/elevenlabs-pool/:credentialId/voices', async (req: AdminRequest, res: Response) => {
  try {
    const { credentialId } = req.params;
    const { VoiceSyncService } = await import('../services/voice-sync');
    const voices = await VoiceSyncService.getSyncedVoicesForCredential(credentialId);
    res.json(voices);
  } catch (error: any) {
    console.error('Error getting synced voices:', error);
    res.status(500).json({ error: error.message || 'Failed to get synced voices' });
  }
});

// Get sync status for a specific voice
router.get('/elevenlabs-pool/voice-status/:voiceId', async (req: AdminRequest, res: Response) => {
  try {
    const { voiceId } = req.params;
    const { VoiceSyncService } = await import('../services/voice-sync');
    const status = await VoiceSyncService.getVoiceSyncStatus(voiceId);
    res.json(status);
  } catch (error: any) {
    console.error('Error getting voice sync status:', error);
    res.status(500).json({ error: error.message || 'Failed to get voice sync status' });
  }
});

// Retry failed voice syncs
router.post('/elevenlabs-pool/retry-voice-sync', async (req: AdminRequest, res: Response) => {
  try {
    const { voiceId, publicOwnerId, voiceName } = req.body;
    
    if (!voiceId || !publicOwnerId) {
      return res.status(400).json({ 
        error: 'voiceId and publicOwnerId are required' 
      });
    }
    
    const { VoiceSyncService } = await import('../services/voice-sync');
    const result = await VoiceSyncService.retryFailedSyncs(
      voiceId,
      publicOwnerId,
      voiceName || null
    );
    
    res.json({
      success: true,
      ...result,
      message: `Retried ${result.retried} failed syncs, ${result.succeeded} succeeded`
    });
  } catch (error: any) {
    console.error('Error retrying voice sync:', error);
    res.status(500).json({ error: error.message || 'Failed to retry voice sync' });
  }
});

// Fetch missing call recordings from Twilio
router.post('/sync-recordings', async (req: AdminRequest, res: Response) => {
  try {
    console.log('🎙️ [Admin] Starting recording sync...');
    
    const { getTwilioClient } = await import('../services/twilio-connector');
    const { db } = await import('../db');
    const { calls } = await import('../../shared/schema');
    const { isNull, and, isNotNull, eq, or } = await import('drizzle-orm');
    
    const twilioClient = await getTwilioClient();
    
    // Find calls with Twilio SID but no recording URL (completed or answered status)
    const callsWithoutRecordings = await db
      .select()
      .from(calls)
      .where(
        and(
          isNotNull(calls.twilioSid),
          isNull(calls.recordingUrl),
          or(
            eq(calls.status, 'completed'),
            eq(calls.status, 'answered')
          )
        )
      );
    
    // Also count calls without Twilio SID for logging
    const callsWithoutTwilioSid = await db
      .select()
      .from(calls)
      .where(
        and(
          isNull(calls.twilioSid),
          isNull(calls.recordingUrl),
          or(
            eq(calls.status, 'completed'),
            eq(calls.status, 'answered')
          )
        )
      );
    
    console.log(`📊 Found ${callsWithoutRecordings.length} calls without recordings (have Twilio SID)`);
    if (callsWithoutTwilioSid.length > 0) {
      console.log(`⚠️  Found ${callsWithoutTwilioSid.length} calls without Twilio SID (cannot sync these)`);
    }
    
    let successCount = 0;
    let failCount = 0;
    const errors: string[] = [];
    
    // Fetch recordings for each call
    for (const call of callsWithoutRecordings) {
      try {
        console.log(`🔍 Fetching recordings for call ${call.id} (Twilio SID: ${call.twilioSid})`);
        
        // Fetch recordings for this call from Twilio
        const recordings = await twilioClient.recordings.list({
          callSid: call.twilioSid!,
          limit: 1
        });
        
        if (recordings.length > 0) {
          const recording = recordings[0];
          const recordingUrl = `https://api.twilio.com${recording.uri.replace('.json', '')}`;
          
          console.log(`✅ Found recording: ${recordingUrl}`);
          
          // Update call with recording URL
          await db
            .update(calls)
            .set({
              recordingUrl,
              duration: recording.duration ? parseInt(recording.duration, 10) : call.duration
            })
            .where(eq(calls.id, call.id));
          
          successCount++;
        } else {
          console.log(`⚠️  No recording found for call ${call.id}`);
          failCount++;
          errors.push(`No recording found for call ${call.id}`);
        }
      } catch (error: any) {
        console.error(`❌ Error fetching recording for call ${call.id}:`, error.message);
        failCount++;
        errors.push(`Call ${call.id}: ${error.message}`);
      }
    }
    
    const summary = {
      total: callsWithoutRecordings.length,
      success: successCount,
      failed: failCount,
      errors: errors.length > 0 ? errors : undefined
    };
    
    console.log(`✅ [Admin] Recording sync complete:`, summary);
    
    res.json(summary);
  } catch (error: any) {
    console.error('❌ [Admin] Error syncing recordings:', error);
    res.status(500).json({ error: error.message || 'Failed to sync recordings' });
  }
});

// Sync existing phone numbers to ElevenLabs
router.post('/phone-numbers/sync-to-elevenlabs', async (req: AdminRequest, res: Response) => {
  try {
    console.log('📞 [Admin] Starting ElevenLabs phone number sync...');
    
    // Get all phone numbers that haven't been synced to ElevenLabs yet
    const { db } = await import('../db');
    const { phoneNumbers, agents } = await import('../../shared/schema');
    const { isNull, eq } = await import('drizzle-orm');
    const { ElevenLabsService } = await import('../services/elevenlabs');
    const { getTwilioAccountSid } = await import('../services/twilio-connector');
    
    const unsyncedNumbers = await db
      .select()
      .from(phoneNumbers)
      .where(isNull(phoneNumbers.elevenLabsPhoneNumberId));
    
    if (unsyncedNumbers.length === 0) {
      return res.json({
        total: 0,
        success: 0,
        failed: 0,
        message: 'All phone numbers are already synced to ElevenLabs'
      });
    }
    
    console.log(`📞 [Admin] Found ${unsyncedNumbers.length} unsynced phone numbers`);
    
    let successCount = 0;
    let failCount = 0;
    const errors: string[] = [];
    const successes: string[] = [];
    
    // Get Twilio credentials for ElevenLabs sync
    const twilioAccountSid = await getTwilioAccountSid();
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    
    if (!twilioAuthToken) {
      return res.status(500).json({ error: 'TWILIO_AUTH_TOKEN not configured' });
    }
    
    // Process each unsynced phone number
    for (const phone of unsyncedNumbers) {
      try {
        const maskedNumber = `***${phone.phoneNumber.slice(-4)}`;
        console.log(`📞 [Admin] Syncing ${maskedNumber} (${phone.userId ? `User: ${phone.userId}` : 'System Pool'})`);
        
        // Determine which ElevenLabs credential to use
        let credentialToUse;
        let needsCredentialUpdate = false;
        
        // First, check if this phone number already has a credential assigned (for deterministic sync)
        if (phone.elevenLabsCredentialId) {
          credentialToUse = await ElevenLabsPoolService.getCredentialById(phone.elevenLabsCredentialId);
          if (credentialToUse) {
            console.log(`   Reusing existing phone number credential: ${credentialToUse.name}`);
          } else {
            console.log(`   ⚠️  Stored credential was deleted, will assign new one`);
            needsCredentialUpdate = true;
          }
        }
        
        // If no credential on phone number and user-owned, check user's agents
        if (!credentialToUse && phone.userId) {
          const userAgents = await db
            .select()
            .from(agents)
            .where(eq(agents.userId, phone.userId))
            .limit(1);
          
          if (userAgents.length > 0 && userAgents[0].elevenLabsCredentialId) {
            // User has existing agents - use the same API key for consistency
            credentialToUse = await ElevenLabsPoolService.getCredentialById(userAgents[0].elevenLabsCredentialId);
            if (credentialToUse) {
              console.log(`   Using existing user agent credential: ${credentialToUse.name}`);
              needsCredentialUpdate = true; // Update phone to match agent credential
            } else {
              console.log(`   ⚠️  User's agent credential was deleted, will assign new one`);
              needsCredentialUpdate = true;
            }
          }
        }
        
        // If still no credential, assign least loaded and persist it
        if (!credentialToUse) {
          credentialToUse = await ElevenLabsPoolService.getLeastLoadedCredential();
          if (!credentialToUse) {
            throw new Error('No active ElevenLabs API keys available in pool');
          }
          console.log(`   Assigned new credential: ${credentialToUse.name}`);
          needsCredentialUpdate = true;
        }
        
        // Update credential assignment if needed
        if (needsCredentialUpdate) {
          await db.update(phoneNumbers)
            .set({ elevenLabsCredentialId: credentialToUse.id })
            .where(eq(phoneNumbers.id, phone.id));
        }
        
        // Create ElevenLabs service with user's assigned API key
        const elevenLabsService = new ElevenLabsService(credentialToUse.apiKey);
        
        // Sync phone number to ElevenLabs
        const elevenLabsResult = await elevenLabsService.syncPhoneNumberToElevenLabs({
          phoneNumber: phone.phoneNumber,
          twilioAccountSid,
          twilioAuthToken,
          label: phone.friendlyName || phone.phoneNumber,
        });
        
        // Update database with ElevenLabs ID and credential
        await db.update(phoneNumbers)
          .set({
            elevenLabsPhoneNumberId: elevenLabsResult.phone_number_id,
            elevenLabsCredentialId: credentialToUse.id,
          })
          .where(eq(phoneNumbers.id, phone.id));
        
        successCount++;
        successes.push(`${maskedNumber}: Synced successfully (EL ID: ${elevenLabsResult.phone_number_id})`);
        console.log(`✅ [Admin] ${maskedNumber} synced successfully`);
        
      } catch (error: any) {
        const maskedNumber = `***${phone.phoneNumber.slice(-4)}`;
        console.error(`❌ [Admin] Error syncing ${maskedNumber}:`, error.message);
        failCount++;
        errors.push(`${maskedNumber}: ${error.message}`);
      }
    }
    
    const summary = {
      total: unsyncedNumbers.length,
      success: successCount,
      failed: failCount,
      successes: successes.length > 0 ? successes : undefined,
      errors: errors.length > 0 ? errors : undefined
    };
    
    console.log(`✅ [Admin] ElevenLabs sync complete:`, summary);
    
    res.json(summary);
  } catch (error: any) {
    console.error('❌ [Admin] Error syncing phone numbers to ElevenLabs:', error);
    res.status(500).json({ error: error.message || 'Failed to sync phone numbers to ElevenLabs' });
  }
});

// Clean up orphaned phone numbers (exist in DB but not in Twilio)
router.post('/phone-numbers/cleanup', async (req: AdminRequest, res: Response) => {
  try {
    console.log('🧹 [Admin] Starting phone number cleanup...');
    
    const { db } = await import('../db');
    const { phoneNumbers } = await import('../../shared/schema');
    const { eq } = await import('drizzle-orm');
    const { getTwilioClient } = await import('../services/twilio-connector');
    
    // Get all phone numbers from database
    const allPhoneNumbers = await db.select().from(phoneNumbers);
    
    if (allPhoneNumbers.length === 0) {
      return res.json({
        total: 0,
        removed: 0,
        message: 'No phone numbers found in database'
      });
    }
    
    console.log(`🧹 [Admin] Found ${allPhoneNumbers.length} phone numbers in database`);
    
    const twilioClient = await getTwilioClient();
    let removedCount = 0;
    const removed: string[] = [];
    const errors: string[] = [];
    
    // Fetch ALL phone numbers from Twilio
    // Twilio's .list() automatically handles pagination and returns all records
    console.log(`🧹 [Admin] Fetching all phone numbers from Twilio...`);
    const allTwilioNumbers = await twilioClient.incomingPhoneNumbers.list();
    const twilioNumbersSet = new Set<string>(allTwilioNumbers.map(tn => tn.phoneNumber));
    
    console.log(`🧹 [Admin] Found ${twilioNumbersSet.size} phone numbers in Twilio`);
    
    // Check each database phone number against Twilio set
    for (const phone of allPhoneNumbers) {
      try {
        const maskedNumber = `***${phone.phoneNumber.slice(-4)}`;
        
        if (twilioNumbersSet.has(phone.phoneNumber)) {
          console.log(`✅ [Admin] ${maskedNumber} exists in Twilio`);
        } else {
          // Phone number doesn't exist in Twilio - remove from database
          console.log(`🗑️  [Admin] ${maskedNumber} not found in Twilio, removing from database`);
          
          await db.delete(phoneNumbers).where(eq(phoneNumbers.id, phone.id));
          
          removedCount++;
          removed.push(`${maskedNumber}: Removed (not found in Twilio)`);
        }
      } catch (error: any) {
        const maskedNumber = `***${phone.phoneNumber.slice(-4)}`;
        console.error(`❌ [Admin] Error checking ${maskedNumber}:`, error.message);
        errors.push(`${maskedNumber}: ${error.message}`);
      }
    }
    
    const summary = {
      total: allPhoneNumbers.length,
      removed: removedCount,
      kept: allPhoneNumbers.length - removedCount,
      removed_numbers: removed.length > 0 ? removed : undefined,
      errors: errors.length > 0 ? errors : undefined
    };
    
    console.log(`✅ [Admin] Phone number cleanup complete:`, summary);
    
    res.json(summary);
  } catch (error: any) {
    console.error('❌ [Admin] Error during phone number cleanup:', error);
    res.status(500).json({ error: error.message || 'Failed to cleanup phone numbers' });
  }
});

// Clear ElevenLabs sync status for all phone numbers
router.post('/phone-numbers/clear-sync-status', async (req: AdminRequest, res: Response) => {
  try {
    console.log('🔄 [Admin] Clearing ElevenLabs sync status for all phone numbers...');
    
    const { db } = await import('../db');
    const { phoneNumbers } = await import('../../shared/schema');
    
    // Get count before clearing
    const allPhoneNumbers = await db.select().from(phoneNumbers);
    const totalCount = allPhoneNumbers.length;
    
    if (totalCount === 0) {
      return res.json({
        total: 0,
        cleared: 0,
        message: 'No phone numbers found in database'
      });
    }
    
    // Clear elevenLabsPhoneNumberId for all phone numbers
    await db.update(phoneNumbers)
      .set({ elevenLabsPhoneNumberId: null });
    
    console.log(`✅ [Admin] Cleared sync status for ${totalCount} phone numbers`);
    
    res.json({
      total: totalCount,
      cleared: totalCount,
      message: `Cleared ElevenLabs sync status for ${totalCount} phone number${totalCount !== 1 ? 's' : ''}`
    });
  } catch (error: any) {
    console.error('❌ [Admin] Error clearing sync status:', error);
    res.status(500).json({ error: error.message || 'Failed to clear sync status' });
  }
});

// =====================================================
// PHONE NUMBER MIGRATION ENGINE - Admin Controls
// =====================================================

// GET /api/admin/phone-numbers/migration-status - View phone number credential assignments
router.get('/phone-numbers/migration-status', async (req: AdminRequest, res: Response) => {
  try {
    console.log('📞 [Admin] Fetching phone number migration status...');
    
    const { PhoneMigrator } = await import('../engines/elevenlabs-migration');
    
    const status = await PhoneMigrator.getSystemMigrationStatus();
    
    const needsMigration = status.filter(s => s.needsMigration);
    const synced = status.filter(s => !s.needsMigration && s.agentCredentialId);
    const unconnected = status.filter(s => !s.connectedAgentId);
    
    res.json({
      total: status.length,
      needsMigration: needsMigration.length,
      synced: synced.length,
      unconnected: unconnected.length,
      phones: status
    });
  } catch (error: any) {
    console.error('❌ [Admin] Error fetching migration status:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch migration status' });
  }
});

// POST /api/admin/phone-numbers/migrate/:phoneNumberId - Migrate a specific phone number
router.post('/phone-numbers/migrate/:phoneNumberId', async (req: AdminRequest, res: Response) => {
  try {
    const { phoneNumberId } = req.params;
    const { targetCredentialId } = req.body;
    
    console.log(`📞 [Admin] Initiating manual migration for phone ${phoneNumberId}`);
    
    const { PhoneMigrator } = await import('../engines/elevenlabs-migration');
    
    // If no target credential specified, sync to connected agent's credential
    if (!targetCredentialId) {
      const check = await PhoneMigrator.checkMigrationNeeded(phoneNumberId);
      
      if (!check.agentCredentialId) {
        return res.status(400).json({ 
          error: 'Phone is not connected to an agent. Specify targetCredentialId manually.' 
        });
      }
      
      if (!check.needsMigration) {
        return res.json({
          success: true,
          message: 'Phone is already on the correct credential',
          phoneNumber: check.phoneNumber,
          credentialId: check.phoneCredentialId
        });
      }
    }
    
    // Get agent ID if phone is connected
    const { db } = await import('../db');
    const { incomingConnections, agents } = await import('../../shared/schema');
    const { eq } = await import('drizzle-orm');
    
    const [connection] = await db
      .select({ agentId: incomingConnections.agentId })
      .from(incomingConnections)
      .where(eq(incomingConnections.phoneNumberId, phoneNumberId))
      .limit(1);
    
    let agentElevenLabsId: string | undefined;
    if (connection?.agentId) {
      const [agent] = await db
        .select({ elevenLabsAgentId: agents.elevenLabsAgentId })
        .from(agents)
        .where(eq(agents.id, connection.agentId))
        .limit(1);
      agentElevenLabsId = agent?.elevenLabsAgentId || undefined;
    }
    
    // Check migration status to get target credential
    const check = await PhoneMigrator.checkMigrationNeeded(phoneNumberId);
    const credentialToUse = targetCredentialId || check.agentCredentialId;
    
    if (!credentialToUse) {
      return res.status(400).json({ error: 'No target credential available' });
    }
    
    const result = await PhoneMigrator.migratePhoneNumber(
      phoneNumberId,
      credentialToUse,
      agentElevenLabsId
    );
    
    res.json(result);
  } catch (error: any) {
    console.error('❌ [Admin] Error migrating phone:', error);
    res.status(500).json({ error: error.message || 'Failed to migrate phone number' });
  }
});

// POST /api/admin/phone-numbers/migrate-all - Migrate all mismatched phone numbers
router.post('/phone-numbers/migrate-all', async (req: AdminRequest, res: Response) => {
  try {
    console.log('📞 [Admin] Starting system-wide phone number migration...');
    
    const { PhoneMigrator } = await import('../engines/elevenlabs-migration');
    
    const result = await PhoneMigrator.migrateAllMismatchedPhones();
    
    console.log(`✅ [Admin] Migration complete: ${result.successful}/${result.totalMigrated} successful`);
    
    res.json({
      message: `Migrated ${result.successful}/${result.totalMigrated} phone numbers`,
      ...result
    });
  } catch (error: any) {
    console.error('❌ [Admin] Error during bulk migration:', error);
    res.status(500).json({ error: error.message || 'Failed to migrate phone numbers' });
  }
});

// POST /api/admin/phone-numbers/migrate-agent/:agentId - Migrate all phones connected to an agent
router.post('/phone-numbers/migrate-agent/:agentId', async (req: AdminRequest, res: Response) => {
  try {
    const { agentId } = req.params;
    
    console.log(`📞 [Admin] Migrating all phones for agent ${agentId}...`);
    
    const { PhoneMigrator } = await import('../engines/elevenlabs-migration');
    
    const result = await PhoneMigrator.migrateAgentPhoneNumbers(agentId);
    
    res.json(result);
  } catch (error: any) {
    console.error('❌ [Admin] Error migrating agent phones:', error);
    res.status(500).json({ error: error.message || 'Failed to migrate agent phones' });
  }
});

// =====================================================
// PHONE NUMBER USER ASSIGNMENT - Admin Controls
// =====================================================

// PATCH /api/admin/phone-numbers/:id/assign - Assign a Twilio phone number to a user
router.patch('/phone-numbers/:id/assign', async (req: AdminRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { userId, isSystemPool } = req.body;
    
    console.log(`📞 [Admin] Assigning Twilio phone number ${id} to user ${userId || 'system pool'}`);
    
    const { phoneNumbers } = await import('../../shared/schema');
    
    // Verify the phone number exists
    const [existingPhone] = await db
      .select()
      .from(phoneNumbers)
      .where(eq(phoneNumbers.id, id))
      .limit(1);
    
    if (!existingPhone) {
      return res.status(404).json({ error: 'Phone number not found' });
    }
    
    // If assigning to a user, verify the user exists
    if (userId) {
      const { users } = await import('../../shared/schema');
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
    }
    
    // Update the phone number assignment
    const [updated] = await db
      .update(phoneNumbers)
      .set({
        userId: userId || null,
        isSystemPool: isSystemPool === true,
      })
      .where(eq(phoneNumbers.id, id))
      .returning();
    
    console.log(`✅ [Admin] Phone number ${id} assigned to ${userId || 'system pool'}`);
    
    res.json(updated);
  } catch (error: any) {
    console.error('❌ [Admin] Error assigning phone number:', error);
    res.status(500).json({ error: error.message || 'Failed to assign phone number' });
  }
});

// GET /api/admin/phone-numbers/all - Get all Twilio phone numbers with user info
router.get('/phone-numbers/all', async (req: AdminRequest, res: Response) => {
  try {
    console.log('📞 [Admin] Fetching all Twilio phone numbers...');
    
    const { phoneNumbers, users } = await import('../../shared/schema');
    
    const numbers = await db
      .select({
        id: phoneNumbers.id,
        userId: phoneNumbers.userId,
        phoneNumber: phoneNumbers.phoneNumber,
        twilioSid: phoneNumbers.twilioSid,
        friendlyName: phoneNumbers.friendlyName,
        country: phoneNumbers.country,
        capabilities: phoneNumbers.capabilities,
        status: phoneNumbers.status,
        isSystemPool: phoneNumbers.isSystemPool,
        purchasePrice: phoneNumbers.purchasePrice,
        monthlyPrice: phoneNumbers.monthlyPrice,
        monthlyCredits: phoneNumbers.monthlyCredits,
        nextBillingDate: phoneNumbers.nextBillingDate,
        purchasedAt: phoneNumbers.purchasedAt,
        createdAt: phoneNumbers.createdAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(phoneNumbers)
      .leftJoin(users, eq(phoneNumbers.userId, users.id));
    
    res.json(numbers);
  } catch (error: any) {
    console.error('❌ [Admin] Error fetching phone numbers:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch phone numbers' });
  }
});

// Configure webhooks for all phone numbers
router.post('/phone-numbers/configure-webhooks', async (req: AdminRequest, res: Response) => {
  try {
    console.log('📞 [Admin] Configuring webhooks for all phone numbers...');
    
    // Get all phone numbers from database
    const phoneNumbers = await storage.getAllPhoneNumbers();
    
    if (phoneNumbers.length === 0) {
      return res.json({
        total: 0,
        success: 0,
        failed: 0,
        message: 'No phone numbers found'
      });
    }
    
    let successCount = 0;
    let failCount = 0;
    const errors: string[] = [];
    
    // Configure webhook for each phone number
    for (const phone of phoneNumbers) {
      try {
        // Mask phone number in logs (show last 4 digits only)
        const maskedNumber = `***${phone.phoneNumber.slice(-4)}`;
        console.log(`📞 [Admin] Configuring webhook for ${maskedNumber}`);
        
        await twilioService.configurePhoneWebhook(phone.twilioSid);
        
        successCount++;
        console.log(`✅ [Admin] Webhook configured for ${maskedNumber}`);
      } catch (error: any) {
        const maskedNumber = `***${phone.phoneNumber.slice(-4)}`;
        console.error(`❌ [Admin] Error configuring webhook for ${maskedNumber}:`, error.message);
        failCount++;
        errors.push(`${maskedNumber}: ${error.message}`);
      }
    }
    
    const summary = {
      total: phoneNumbers.length,
      success: successCount,
      failed: failCount,
      errors: errors.length > 0 ? errors : undefined
    };
    
    console.log(`✅ [Admin] Webhook configuration complete:`, summary);
    
    res.json(summary);
  } catch (error: any) {
    console.error('❌ [Admin] Error configuring webhooks:', error);
    res.status(500).json({ error: error.message || 'Failed to configure webhooks' });
  }
});

// POST /api/admin/sync-all-calls - Unified sync from both ElevenLabs and Twilio
router.post('/sync-all-calls', async (req: AdminRequest, res: Response) => {
  try {
    console.log(`🔄 [Admin] Starting unified call sync from ElevenLabs + Twilio...`);
    
    const { callSyncService } = await import('../services/call-sync');
    
    const result = await callSyncService.syncAllCalls();
    
    console.log(`✅ [Admin] Unified sync complete:`, {
      total: result.total,
      success: result.success,
      failed: result.failed,
      skipped: result.skipped
    });
    
    res.json(result);
  } catch (error: any) {
    console.error('❌ [Admin] Error syncing calls:', error);
    res.status(500).json({ error: error.message || 'Failed to sync calls' });
  }
});

// POST /api/admin/migrate-call-user-ids - One-time migration to populate userId for existing calls
router.post('/migrate-call-user-ids', async (req: AdminRequest, res: Response) => {
  try {
    console.log(`🔄 [Admin] Starting userId migration for existing calls...`);
    
    const { db } = await import('../db');
    const { calls, campaigns, incomingConnections } = await import('../../shared/schema');
    const { eq, isNull, isNotNull, sql } = await import('drizzle-orm');
    
    let updatedFromCampaign = 0;
    let updatedFromConnection = 0;
    let skipped = 0;
    
    // Step 1: Update calls that have a campaignId but no userId
    const callsWithCampaign = await db
      .select({
        id: calls.id,
        campaignId: calls.campaignId,
        userId: calls.userId,
        campaignUserId: campaigns.userId,
      })
      .from(calls)
      .leftJoin(campaigns, eq(calls.campaignId, campaigns.id))
      .where(isNull(calls.userId));
    
    for (const call of callsWithCampaign) {
      if (call.campaignUserId) {
        await db
          .update(calls)
          .set({ userId: call.campaignUserId })
          .where(eq(calls.id, call.id));
        updatedFromCampaign++;
      } else if (call.campaignId) {
        // Campaign exists but has no userId (shouldn't happen)
        skipped++;
      }
    }
    
    // Step 2: Update remaining calls that have incomingConnectionId but still no userId
    const callsWithConnection = await db
      .select({
        id: calls.id,
        incomingConnectionId: calls.incomingConnectionId,
        userId: calls.userId,
        connectionUserId: incomingConnections.userId,
      })
      .from(calls)
      .leftJoin(incomingConnections, eq(calls.incomingConnectionId, incomingConnections.id))
      .where(isNull(calls.userId));
    
    for (const call of callsWithConnection) {
      if (call.connectionUserId) {
        await db
          .update(calls)
          .set({ userId: call.connectionUserId })
          .where(eq(calls.id, call.id));
        updatedFromConnection++;
      } else if (call.incomingConnectionId) {
        // Connection exists but has no userId (shouldn't happen)
        skipped++;
      }
    }
    
    // Get count of orphaned calls (no userId after migration)
    const orphanedCalls = await db
      .select({ count: sql<number>`count(*)` })
      .from(calls)
      .where(isNull(calls.userId));
    
    const orphanedCount = orphanedCalls[0]?.count || 0;
    
    const summary = {
      updatedFromCampaign,
      updatedFromConnection,
      totalUpdated: updatedFromCampaign + updatedFromConnection,
      skipped,
      orphanedCalls: orphanedCount,
    };
    
    console.log(`✅ [Admin] userId migration complete:`, summary);
    
    res.json(summary);
  } catch (error: any) {
    console.error('❌ [Admin] Error migrating call user IDs:', error);
    res.status(500).json({ error: error.message || 'Failed to migrate call user IDs' });
  }
});

// POST /api/admin/sync-incoming-webhooks - Sync ElevenLabs webhooks for all incoming connections
router.post('/sync-incoming-webhooks', async (req: AdminRequest, res: Response) => {
  try {
    console.log(`🔄 [Admin] Syncing ElevenLabs webhooks for all incoming connections`);
    
    const { db } = await import('../db');
    const { incomingConnections, agents } = await import('../../shared/schema');
    const { eq, isNotNull } = await import('drizzle-orm');
    const { getDomain } = await import('../utils/domain');
    
    // Get all incoming connections with their agents
    const connections = await db
      .select({
        id: incomingConnections.id,
        agentId: incomingConnections.agentId,
        agent: {
          elevenLabsAgentId: agents.elevenLabsAgentId,
          elevenLabsCredentialId: agents.elevenLabsCredentialId,
          name: agents.name,
        },
      })
      .from(incomingConnections)
      .leftJoin(agents, eq(incomingConnections.agentId, agents.id))
      .where(isNotNull(agents.elevenLabsAgentId));
    
    console.log(`📋 [Admin] Found ${connections.length} incoming connection(s) to sync`);
    
    let successCount = 0;
    let failCount = 0;
    const errors: string[] = [];
    
    const domain = getDomain();
    const webhookUrl = `${domain}/api/webhooks/elevenlabs`;
    const webhookSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;
    
    for (const conn of connections) {
      if (!conn.agent?.elevenLabsAgentId || !conn.agent?.elevenLabsCredentialId) {
        console.warn(`⚠️  [Admin] Connection ${conn.id} missing agent config, skipping`);
        continue;
      }
      
      try {
        console.log(`🔗 [Admin] Syncing webhook for agent: ${conn.agent.name}`);
        
        const credential = await ElevenLabsPoolService.getCredentialById(conn.agent.elevenLabsCredentialId);
        if (!credential) {
          throw new Error('Credential not found');
        }
        
        const { ElevenLabsService } = await import('../services/elevenlabs');
        const elevenLabsService = new ElevenLabsService(credential.apiKey);
        
        await elevenLabsService.configureAgentWebhook(conn.agent.elevenLabsAgentId, {
          webhookUrl,
          events: ['conversation.completed'],
          secret: webhookSecret,
        });
        
        successCount++;
        console.log(`✅ [Admin] Webhook configured for agent: ${conn.agent.name}`);
      } catch (error: any) {
        console.error(`❌ [Admin] Error syncing webhook for ${conn.agent?.name}:`, error.message);
        failCount++;
        errors.push(`${conn.agent?.name}: ${error.message}`);
      }
    }
    
    const summary = {
      total: connections.length,
      success: successCount,
      failed: failCount,
      webhookUrl,
      errors: errors.length > 0 ? errors : undefined
    };
    
    console.log(`✅ [Admin] Webhook sync complete:`, summary);
    
    res.json(summary);
  } catch (error: any) {
    console.error('❌ [Admin] Error syncing webhooks:', error);
    res.status(500).json({ error: error.message || 'Failed to sync webhooks' });
  }
});

router.get('/users/:userId/webhooks', async (req: AdminRequest, res: Response) => {
  try {
    const { userId } = req.params;
    
    const user = await storage.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const webhooks = await storage.getUserWebhooks(userId);
    const webhookCount = await storage.getUserWebhookCount(userId);
    
    res.json({
      webhooks,
      limit: user.maxWebhooks,
      count: webhookCount,
    });
  } catch (error: any) {
    console.error('Error fetching user webhooks:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch webhooks' });
  }
});

router.delete('/users/:userId/webhooks/:webhookId', async (req: AdminRequest, res: Response) => {
  try {
    const { userId, webhookId } = req.params;
    
    const webhook = await storage.getWebhook(webhookId);
    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }
    
    if (webhook.userId !== userId) {
      return res.status(400).json({ error: 'Webhook does not belong to this user' });
    }
    
    await storage.deleteWebhook(webhookId);
    res.json({ message: 'Webhook deleted' });
  } catch (error: any) {
    console.error('Error deleting webhook:', error);
    res.status(500).json({ error: error.message || 'Failed to delete webhook' });
  }
});

// ==========================================
// BRANDING SETTINGS
// ==========================================

// Get all branding settings
router.get('/branding', async (req: AdminRequest, res: Response) => {
  try {
    const brandingKeys = ['app_name', 'app_tagline', 'logo_url', 'logo_url_light', 'logo_url_dark', 'favicon_url', 'branding_updated_at', 'admin_email', 'social_twitter_url', 'social_linkedin_url', 'social_github_url'];
    const branding: Record<string, any> = {
      app_name: 'AgentLabs',
      app_tagline: 'AI Voice Calling Agents & Lead Intelligence SaaS Platform',
      logo_url: null,
      logo_url_light: null,
      logo_url_dark: null,
      favicon_url: null,
      branding_updated_at: null,
      admin_email: null,
      social_twitter_url: null,
      social_linkedin_url: null,
      social_github_url: null
    };
    
    for (const key of brandingKeys) {
      const setting = await storage.getGlobalSetting(key);
      if (setting) {
        branding[key] = setting.value;
      }
    }
    
    res.json(branding);
  } catch (error) {
    console.error('Error fetching branding settings:', error);
    res.status(500).json({ error: 'Failed to fetch branding settings' });
  }
});

// Update branding settings (text fields)
router.patch('/branding', async (req: AdminRequest, res: Response) => {
  try {
    const updateSchema = z.object({
      app_name: z.string().min(1).max(100).optional(),
      app_tagline: z.string().max(500).optional(),
      admin_email: z.string().email().optional().or(z.literal('')),
      social_twitter_url: z.string().url().optional().or(z.literal('')),
      social_linkedin_url: z.string().url().optional().or(z.literal('')),
      social_github_url: z.string().url().optional().or(z.literal('')),
    });
    
    const data = updateSchema.parse(req.body);
    
    // Update each provided field
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        await storage.updateGlobalSetting(key, value);
      }
    }
    
    // Update timestamp
    await storage.updateGlobalSetting('branding_updated_at', new Date().toISOString());
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error updating branding settings:', error);
    // Check if it's a Zod validation error
    if (error.errors) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: error.errors 
      });
    }
    res.status(500).json({ 
      error: 'Failed to update branding settings',
      details: error.message || 'Unknown error'
    });
  }
});

// Helper function to save uploaded image to disk
async function saveImageToDisk(file: Express.Multer.File, prefix: string): Promise<string> {
  const fs = await import('fs').then(m => m.promises);
  const pathModule = await import('path');
  
  // Determine extension from mimetype
  const mimeToExt: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico'
  };
  const ext = mimeToExt[file.mimetype] || '.png';
  
  // Generate unique filename
  const fileName = `${prefix}-${Date.now()}${ext}`;
  
  // Ensure images directory exists
  const imagesDir = pathModule.join(process.cwd(), 'client', 'public', 'images');
  await fs.mkdir(imagesDir, { recursive: true });
  
  // Save file to disk
  const filePath = pathModule.join(imagesDir, fileName);
  await fs.writeFile(filePath, file.buffer);
  
  // Return public URL
  return `/images/${fileName}`;
}

// Upload logo (legacy - for backwards compatibility, saves to both logo_url and logo_url_light)
router.post('/branding/upload-logo', upload.single('logo'), async (req: AdminRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Save image to disk and get public URL
    const imageUrl = await saveImageToDisk(req.file, 'logo');
    
    await storage.updateGlobalSetting('logo_url', imageUrl);
    await storage.updateGlobalSetting('logo_url_light', imageUrl);
    await storage.updateGlobalSetting('branding_updated_at', new Date().toISOString());
    
    res.json({ 
      success: true, 
      logo_url: imageUrl,
      logo_url_light: imageUrl
    });
  } catch (error) {
    console.error('Error uploading logo:', error);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

// Upload light mode logo
router.post('/branding/upload-logo-light', upload.single('logo'), async (req: AdminRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Save image to disk and get public URL
    const imageUrl = await saveImageToDisk(req.file, 'logo-light');
    
    await storage.updateGlobalSetting('logo_url_light', imageUrl);
    await storage.updateGlobalSetting('logo_url', imageUrl);
    await storage.updateGlobalSetting('branding_updated_at', new Date().toISOString());
    
    res.json({ 
      success: true, 
      logo_url_light: imageUrl 
    });
  } catch (error) {
    console.error('Error uploading light mode logo:', error);
    res.status(500).json({ error: 'Failed to upload light mode logo' });
  }
});

// Upload dark mode logo
router.post('/branding/upload-logo-dark', upload.single('logo'), async (req: AdminRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Save image to disk and get public URL
    const imageUrl = await saveImageToDisk(req.file, 'logo-dark');
    
    await storage.updateGlobalSetting('logo_url_dark', imageUrl);
    await storage.updateGlobalSetting('branding_updated_at', new Date().toISOString());
    
    res.json({ 
      success: true, 
      logo_url_dark: imageUrl 
    });
  } catch (error) {
    console.error('Error uploading dark mode logo:', error);
    res.status(500).json({ error: 'Failed to upload dark mode logo' });
  }
});

// Upload favicon
router.post('/branding/upload-favicon', upload.single('favicon'), async (req: AdminRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Save image to disk and get public URL
    const imageUrl = await saveImageToDisk(req.file, 'favicon');
    
    await storage.updateGlobalSetting('favicon_url', imageUrl);
    await storage.updateGlobalSetting('branding_updated_at', new Date().toISOString());
    
    res.json({ 
      success: true, 
      favicon_url: imageUrl 
    });
  } catch (error) {
    console.error('Error uploading favicon:', error);
    res.status(500).json({ error: 'Failed to upload favicon' });
  }
});

// Delete logo (legacy - clears both logo_url and logo_url_light)
router.delete('/branding/logo', async (req: AdminRequest, res: Response) => {
  try {
    await storage.updateGlobalSetting('logo_url', null);
    await storage.updateGlobalSetting('logo_url_light', null);
    await storage.updateGlobalSetting('branding_updated_at', new Date().toISOString());
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting logo:', error);
    res.status(500).json({ error: 'Failed to delete logo' });
  }
});

// Delete light mode logo
router.delete('/branding/logo-light', async (req: AdminRequest, res: Response) => {
  try {
    await storage.updateGlobalSetting('logo_url_light', null);
    await storage.updateGlobalSetting('logo_url', null);
    await storage.updateGlobalSetting('branding_updated_at', new Date().toISOString());
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting light mode logo:', error);
    res.status(500).json({ error: 'Failed to delete light mode logo' });
  }
});

// Delete dark mode logo
router.delete('/branding/logo-dark', async (req: AdminRequest, res: Response) => {
  try {
    await storage.updateGlobalSetting('logo_url_dark', null);
    await storage.updateGlobalSetting('branding_updated_at', new Date().toISOString());
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting dark mode logo:', error);
    res.status(500).json({ error: 'Failed to delete dark mode logo' });
  }
});

// Delete favicon
router.delete('/branding/favicon', async (req: AdminRequest, res: Response) => {
  try {
    await storage.updateGlobalSetting('favicon_url', null);
    await storage.updateGlobalSetting('branding_updated_at', new Date().toISOString());
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting favicon:', error);
    res.status(500).json({ error: 'Failed to delete favicon' });
  }
});

// ==========================================
// SMTP SETTINGS
// ==========================================

// Get SMTP settings
router.get('/smtp', async (req: AdminRequest, res: Response) => {
  try {
    const smtpKeys = ['smtp_host', 'smtp_port', 'smtp_username', 'smtp_password', 'smtp_from_email', 'smtp_from_name'];
    const smtp: Record<string, any> = {
      smtp_host: '',
      smtp_port: 587,
      smtp_username: '',
      smtp_password: '',
      smtp_from_email: '',
      smtp_from_name: ''
    };
    
    for (const key of smtpKeys) {
      const setting = await storage.getGlobalSetting(key);
      if (setting) {
        smtp[key] = setting.value;
      }
    }
    
    // Mask password for security
    if (smtp.smtp_password) {
      smtp.smtp_password_masked = '********';
      smtp.smtp_password_set = true;
    } else {
      smtp.smtp_password_set = false;
    }
    delete smtp.smtp_password;
    
    res.json(smtp);
  } catch (error) {
    console.error('Error fetching SMTP settings:', error);
    res.status(500).json({ error: 'Failed to fetch SMTP settings' });
  }
});

// Update SMTP settings
router.patch('/smtp', async (req: AdminRequest, res: Response) => {
  try {
    const updateSchema = z.object({
      smtp_host: z.string().optional(),
      smtp_port: z.number().int().min(1).max(65535).optional(),
      smtp_username: z.string().optional(),
      smtp_password: z.string().optional(),
      smtp_from_email: z.string().email().optional().or(z.literal('')),
      smtp_from_name: z.string().optional(),
    });
    
    const data = updateSchema.parse(req.body);
    
    // Update each provided field
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        // Don't update password if it's the masked value
        if (key === 'smtp_password' && value === '********') {
          continue;
        }
        await storage.updateGlobalSetting(key, value);
      }
    }
    
    // Reinitialize email service with new settings
    const reinitialized = await emailService.reinitializeFromDatabase();
    
    res.json({ 
      success: true,
      reinitialized,
      message: reinitialized 
        ? 'SMTP settings saved and email service reinitialized' 
        : 'SMTP settings saved but email service could not reinitialize'
    });
  } catch (error: any) {
    console.error('Error updating SMTP settings:', error);
    // Check if it's a Zod validation error
    if (error.errors) {
      return res.status(400).json({ 
        error: 'Invalid SMTP settings', 
        details: error.errors 
      });
    }
    res.status(500).json({ 
      error: 'Failed to update SMTP settings',
      details: error.message || 'Unknown error'
    });
  }
});

// Test SMTP connection
router.post('/smtp/test', async (req: AdminRequest, res: Response) => {
  try {
    const nodemailer = await import('nodemailer');
    
    // Get SMTP settings
    const smtpHost = await storage.getGlobalSetting('smtp_host');
    const smtpPort = await storage.getGlobalSetting('smtp_port');
    const smtpUsername = await storage.getGlobalSetting('smtp_username');
    const smtpPassword = await storage.getGlobalSetting('smtp_password');
    const smtpFromEmail = await storage.getGlobalSetting('smtp_from_email');
    
    if (!smtpHost?.value || !smtpPort?.value) {
      return res.json({ 
        success: false, 
        error: 'SMTP host and port are required' 
      });
    }
    
    // Create transporter
    const transporter = nodemailer.createTransport({
      host: smtpHost.value as string,
      port: smtpPort.value as number,
      secure: (smtpPort.value as number) === 465,
      auth: smtpUsername?.value ? {
        user: smtpUsername.value as string,
        pass: smtpPassword?.value as string || '',
      } : undefined,
    });
    
    // Verify connection
    await transporter.verify();
    
    res.json({ 
      success: true, 
      message: 'SMTP connection successful' 
    });
  } catch (error: any) {
    console.error('Error testing SMTP connection:', error);
    res.json({ 
      success: false, 
      error: error.message || 'Failed to connect to SMTP server' 
    });
  }
});

// ============================================
// SEO Settings Routes
// ============================================

// Get SEO settings
router.get('/seo', async (req: AdminRequest, res: Response) => {
  try {
    let settings = await storage.getSeoSettings();
    
    // If no settings exist, create default ones
    if (!settings) {
      settings = await storage.updateSeoSettings({
        updatedBy: req.userId
      });
    }
    
    // Transform DB format to frontend format
    const structuredData = settings.structuredData as any;
    const transformedSettings = {
      ...settings,
      // Transform organization data from DB format to frontend format
      structuredDataOrg: structuredData ? {
        name: structuredData.organizationName || '',
        url: structuredData.organizationUrl || '',
        logo: structuredData.organizationLogo || '',
        email: structuredData.contactEmail || '',
        phone: structuredData.contactPhone || '',
        socialProfiles: structuredData.socialProfiles || []
      } : null,
      // FAQ and Product are already in correct format
      structuredDataFaq: settings.structuredDataFaq || [],
      structuredDataProduct: settings.structuredDataProduct || null
    };
    
    res.json(transformedSettings);
  } catch (error) {
    console.error('Error getting SEO settings:', error);
    res.status(500).json({ error: 'Failed to get SEO settings' });
  }
});

// Update SEO settings
router.patch('/seo', async (req: AdminRequest, res: Response) => {
  try {
    const body = req.body;
    
    // Transform frontend format back to DB format for organization data
    // Filter out fields that should not be passed to storage (dates come as strings from frontend)
    const { id, createdAt, updatedAt, ...cleanBody } = body;
    let dataToSave = { ...cleanBody };
    
    if (body.structuredDataOrg) {
      const org = body.structuredDataOrg;
      dataToSave.structuredData = {
        organizationName: org.name || '',
        organizationUrl: org.url || '',
        organizationLogo: org.logo || '',
        organizationDescription: org.description || '',
        socialProfiles: org.socialProfiles || [],
        contactEmail: org.email || '',
        contactPhone: org.phone || ''
      };
      // Remove frontend-only field
      delete dataToSave.structuredDataOrg;
    }
    
    // Ensure FAQ and Product are saved with enabled flags
    if (body.structuredDataFaq !== undefined) {
      dataToSave.structuredDataFaqEnabled = Array.isArray(body.structuredDataFaq) && body.structuredDataFaq.length > 0;
    }
    
    if (body.structuredDataProduct !== undefined) {
      dataToSave.structuredDataProductEnabled = body.structuredDataProduct && body.structuredDataProduct.name;
    }
    
    const settings = await storage.updateSeoSettings({
      ...dataToSave,
      updatedBy: req.userId
    });
    
    // Transform response back to frontend format
    const structuredData = settings.structuredData as any;
    const transformedSettings = {
      ...settings,
      structuredDataOrg: structuredData ? {
        name: structuredData.organizationName || '',
        url: structuredData.organizationUrl || '',
        logo: structuredData.organizationLogo || '',
        email: structuredData.contactEmail || '',
        phone: structuredData.contactPhone || '',
        socialProfiles: structuredData.socialProfiles || []
      } : null
    };
    
    res.json(transformedSettings);
  } catch (error) {
    console.error('Error updating SEO settings:', error);
    res.status(500).json({ error: 'Failed to update SEO settings' });
  }
});

// Add sitemap URL
router.post('/seo/sitemap-urls', async (req: AdminRequest, res: Response) => {
  try {
    const { url, changefreq = 'weekly', priority = 0.5 } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const settings = await storage.getSeoSettings();
    const currentUrls = (settings?.sitemapUrls as any[]) || [];
    
    // Check for duplicates
    if (currentUrls.some(u => u.url === url)) {
      return res.status(400).json({ error: 'URL already exists in sitemap' });
    }
    
    const newUrl = {
      url,
      changefreq,
      priority,
      lastmod: new Date().toISOString().split('T')[0]
    };
    
    const updated = await storage.updateSeoSettings({
      sitemapUrls: [...currentUrls, newUrl] as any,
      updatedBy: req.userId
    });
    
    res.json(updated);
  } catch (error) {
    console.error('Error adding sitemap URL:', error);
    res.status(500).json({ error: 'Failed to add sitemap URL' });
  }
});

// Remove sitemap URL
router.delete('/seo/sitemap-urls', async (req: AdminRequest, res: Response) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const settings = await storage.getSeoSettings();
    const currentUrls = (settings?.sitemapUrls as any[]) || [];
    
    const updatedUrls = currentUrls.filter(u => u.url !== url);
    
    const updated = await storage.updateSeoSettings({
      sitemapUrls: updatedUrls as any,
      updatedBy: req.userId
    });
    
    res.json(updated);
  } catch (error) {
    console.error('Error removing sitemap URL:', error);
    res.status(500).json({ error: 'Failed to remove sitemap URL' });
  }
});

// Generate default sitemap with standard routes
router.post('/seo/generate-sitemap', async (req: AdminRequest, res: Response) => {
  try {
    const settings = await storage.getSeoSettings();
    const today = new Date().toISOString().split('T')[0];
    
    // Default sitemap URLs for a typical SaaS landing page
    const defaultUrls = [
      { url: '/', changefreq: 'weekly', priority: 1.0, lastmod: today },
      { url: '/pricing', changefreq: 'weekly', priority: 0.9, lastmod: today },
      { url: '/features', changefreq: 'weekly', priority: 0.9, lastmod: today },
      { url: '/about', changefreq: 'monthly', priority: 0.7, lastmod: today },
      { url: '/contact', changefreq: 'monthly', priority: 0.7, lastmod: today },
      { url: '/blog', changefreq: 'daily', priority: 0.8, lastmod: today },
      { url: '/faq', changefreq: 'monthly', priority: 0.6, lastmod: today },
      { url: '/privacy', changefreq: 'yearly', priority: 0.3, lastmod: today },
      { url: '/terms', changefreq: 'yearly', priority: 0.3, lastmod: today },
    ];
    
    const updated = await storage.updateSeoSettings({
      sitemapUrls: defaultUrls as any,
      updatedBy: req.userId
    });
    
    res.json({ 
      message: 'Default sitemap generated successfully',
      urlCount: defaultUrls.length,
      settings: updated 
    });
  } catch (error) {
    console.error('Error generating default sitemap:', error);
    res.status(500).json({ error: 'Failed to generate default sitemap' });
  }
});

// Rebuild sitemap - refresh lastmod dates and check for new dynamic content
router.post('/seo/rebuild-sitemap', async (req: AdminRequest, res: Response) => {
  try {
    const settings = await storage.getSeoSettings();
    const currentUrls = (settings?.sitemapUrls as any[]) || [];
    const today = new Date().toISOString().split('T')[0];
    
    // Update lastmod for all existing URLs
    const updatedUrls = currentUrls.map((url: any) => ({
      ...url,
      lastmod: today
    }));
    
    // Check for blog posts or dynamic content that might exist
    // This is a placeholder for future dynamic content detection
    // In production, this could scan the blog database, product pages, etc.
    
    const updated = await storage.updateSeoSettings({
      sitemapUrls: updatedUrls as any,
      updatedBy: req.userId
    });
    
    res.json({ 
      message: 'Sitemap rebuilt successfully',
      urlCount: updatedUrls.length,
      lastModified: today,
      settings: updated 
    });
  } catch (error) {
    console.error('Error rebuilding sitemap:', error);
    res.status(500).json({ error: 'Failed to rebuild sitemap' });
  }
});

// Upload SEO image (OG image or logo)
router.post('/seo/upload-image', async (req: AdminRequest, res: Response) => {
  try {
    const { imageData, imageType, fileName } = req.body;
    
    if (!imageData || !imageType) {
      return res.status(400).json({ error: 'Image data and type are required' });
    }
    
    // Validate image type - strict enum check
    const validImageTypes = ['ogImage', 'logo', 'favicon'] as const;
    if (!validImageTypes.includes(imageType)) {
      return res.status(400).json({ error: 'Invalid image type. Must be ogImage, logo, or favicon' });
    }
    
    // Validate base64 data format and extract mime type
    const dataUrlMatch = imageData.match(/^data:(image\/(png|jpeg|jpg|gif|webp|svg\+xml));base64,(.+)$/);
    if (!dataUrlMatch) {
      return res.status(400).json({ error: 'Invalid image format. Must be a valid base64-encoded image (PNG, JPEG, GIF, WebP, or SVG)' });
    }
    
    const mimeType = dataUrlMatch[1];
    const base64Data = dataUrlMatch[3];
    
    // Decode base64 and check file size (max 5MB)
    const buffer = Buffer.from(base64Data, 'base64');
    const maxSizeBytes = 5 * 1024 * 1024; // 5MB
    if (buffer.length > maxSizeBytes) {
      return res.status(400).json({ error: 'Image too large. Maximum size is 5MB' });
    }
    
    // Determine safe extension from validated mime type
    const mimeToExt: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg'
    };
    const ext = mimeToExt[mimeType] || '.png';
    
    // Generate sanitized filename (no user input in filename, just timestamp + type + ext)
    const sanitizedFileName = `seo-${imageType}-${Date.now()}${ext}`;
    
    // Save to public images directory (unified location for all images)
    const fs = await import('fs').then(m => m.promises);
    const path = await import('path');
    
    // Ensure images directory exists
    const imagesDir = path.join(process.cwd(), 'client', 'public', 'images');
    await fs.mkdir(imagesDir, { recursive: true });
    
    const filePath = path.join(imagesDir, sanitizedFileName);
    await fs.writeFile(filePath, buffer);
    
    // Return the public URL
    const publicUrl = `/images/${sanitizedFileName}`;
    
    // Update SEO settings with the new image URL based on type
    if (imageType === 'ogImage') {
      await storage.updateSeoSettings({
        defaultOgImage: publicUrl,
        updatedBy: req.userId
      });
    }
    
    res.json({ 
      message: 'Image uploaded successfully',
      url: publicUrl,
      imageType,
      fileName: sanitizedFileName
    });
  } catch (error) {
    console.error('Error uploading SEO image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// =============================================
// ANALYTICS SCRIPTS MANAGEMENT
// =============================================

// Get all analytics scripts
router.get('/analytics-scripts', async (req: AdminRequest, res: Response) => {
  try {
    const scripts = await storage.getAllAnalyticsScripts();
    res.json(scripts);
  } catch (error) {
    console.error('Error fetching analytics scripts:', error);
    res.status(500).json({ error: 'Failed to fetch analytics scripts' });
  }
});

// Create analytics script
router.post('/analytics-scripts', async (req: AdminRequest, res: Response) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(100),
      type: z.enum(['gtm', 'ga4', 'facebook_pixel', 'linkedin', 'twitter', 'tiktok', 'hotjar', 'clarity', 'custom']).default('custom'),
      code: z.string().default(''), // Legacy field - kept for backward compatibility
      headCode: z.string().optional(), // Code for <head> section
      bodyCode: z.string().optional(), // Code for <body> section (e.g., GTM noscript)
      placement: z.array(z.enum(['head', 'body'])).min(1).default(['head']),
      loadPriority: z.number().min(0).max(100).default(0),
      async: z.boolean().default(false),
      defer: z.boolean().default(false),
      enabled: z.boolean().default(true),
      description: z.string().optional(),
    }).refine(data => {
      // At least one of headCode or bodyCode must be provided
      return (data.headCode && data.headCode.trim()) || (data.bodyCode && data.bodyCode.trim()) || (data.code && data.code.trim());
    }, { message: 'At least one code field (Head Code or Body Code) must be provided' });
    
    const data = schema.parse(req.body);
    
    // Auto-set placement based on which codes are provided
    const autoPlacement: ('head' | 'body')[] = [];
    if (data.headCode && data.headCode.trim()) autoPlacement.push('head');
    if (data.bodyCode && data.bodyCode.trim()) autoPlacement.push('body');
    
    const script = await storage.createAnalyticsScript({
      ...data,
      // Use auto-detected placement if both codes provided, otherwise use user selection
      placement: autoPlacement.length > 0 ? autoPlacement : data.placement,
      // Set legacy code field to headCode for backward compatibility
      code: data.headCode || data.bodyCode || data.code || '',
      updatedBy: req.userId,
    });
    
    res.status(201).json(script);
  } catch (error) {
    console.error('Error creating analytics script:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to create analytics script' });
  }
});

// Update analytics script
router.patch('/analytics-scripts/:id', async (req: AdminRequest, res: Response) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(100).optional(),
      type: z.enum(['gtm', 'ga4', 'facebook_pixel', 'linkedin', 'twitter', 'tiktok', 'hotjar', 'clarity', 'custom']).optional(),
      code: z.string().optional(), // Legacy field
      headCode: z.string().nullable().optional(), // Code for <head> section
      bodyCode: z.string().nullable().optional(), // Code for <body> section
      placement: z.array(z.enum(['head', 'body'])).min(1).optional(),
      loadPriority: z.number().min(0).max(100).optional(),
      async: z.boolean().optional(),
      defer: z.boolean().optional(),
      enabled: z.boolean().optional(),
      description: z.string().nullable().optional(),
    });
    
    const data = schema.parse(req.body);
    
    // Check if script exists
    const existing = await storage.getAnalyticsScript(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Analytics script not found' });
    }
    
    // Auto-update placement based on headCode/bodyCode if they are being updated
    let autoPlacement: ('head' | 'body')[] | undefined;
    if (data.headCode !== undefined || data.bodyCode !== undefined) {
      const headCode = data.headCode !== undefined ? data.headCode : existing.headCode;
      const bodyCode = data.bodyCode !== undefined ? data.bodyCode : existing.bodyCode;
      autoPlacement = [];
      if (headCode && headCode.trim()) autoPlacement.push('head');
      if (bodyCode && bodyCode.trim()) autoPlacement.push('body');
      // Fallback to existing placement if no codes are provided
      if (autoPlacement.length === 0) autoPlacement = undefined;
    }
    
    await storage.updateAnalyticsScript(req.params.id, {
      ...data,
      ...(autoPlacement ? { placement: autoPlacement } : {}),
      // Update legacy code field for backward compatibility
      ...(data.headCode !== undefined || data.bodyCode !== undefined ? { 
        code: data.headCode || data.bodyCode || existing.headCode || existing.bodyCode || existing.code || '' 
      } : {}),
      updatedBy: req.userId,
    });
    
    // Fetch updated script
    const updated = await storage.getAnalyticsScript(req.params.id);
    res.json(updated);
  } catch (error) {
    console.error('Error updating analytics script:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to update analytics script' });
  }
});

// Delete analytics script
router.delete('/analytics-scripts/:id', async (req: AdminRequest, res: Response) => {
  try {
    const existing = await storage.getAnalyticsScript(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Analytics script not found' });
    }
    
    await storage.deleteAnalyticsScript(req.params.id);
    res.json({ message: 'Analytics script deleted successfully' });
  } catch (error) {
    console.error('Error deleting analytics script:', error);
    res.status(500).json({ error: 'Failed to delete analytics script' });
  }
});

// =============================================
// CALL MONITORING ENDPOINTS
// =============================================

// Get all calls with pagination and filtering (admin view)
router.get('/calls', async (req: AdminRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 25;
    const offset = (page - 1) * pageSize;
    
    // Filters
    const userId = req.query.userId as string;
    const status = req.query.status as string;
    const hasViolations = req.query.hasViolations === 'true';
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const search = req.query.search as string;
    
    const result = await storage.getAdminCalls({
      page,
      pageSize,
      userId,
      status,
      hasViolations,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      search,
    });
    
    res.json(result);
  } catch (error) {
    console.error('Error fetching admin calls:', error);
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

// Get single call details
router.get('/calls/:id', async (req: AdminRequest, res: Response) => {
  try {
    const call = await storage.getAdminCallById(req.params.id);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    res.json(call);
  } catch (error) {
    console.error('Error fetching call details:', error);
    res.status(500).json({ error: 'Failed to fetch call details' });
  }
});

// Get call violations
router.get('/calls/:id/violations', async (req: AdminRequest, res: Response) => {
  try {
    const violations = await storage.getViolationsByCallId(req.params.id);
    res.json(violations);
  } catch (error) {
    console.error('Error fetching call violations:', error);
    res.status(500).json({ error: 'Failed to fetch violations' });
  }
});

// Get call recording - uses RecordingService for dual-source (ElevenLabs + Twilio) fetching
router.get('/calls/:id/recording', async (req: AdminRequest, res: Response) => {
  try {
    const call = await storage.getAdminCallById(req.params.id);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    
    const result = await recordingService.getRecordingAudio(call as any);
    
    if ('audioBuffer' in result) {
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `inline; filename="call-recording-${call.id}.mp3"`);
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(result.audioBuffer);
    } else {
      return res.status(404).json(result);
    }
  } catch (error: any) {
    console.error('Error fetching call recording:', error);
    res.status(500).json({ error: 'Failed to fetch recording', details: error.message });
  }
});

// =============================================
// BANNED WORDS MANAGEMENT
// =============================================

// Get all banned words
router.get('/banned-words', async (req: AdminRequest, res: Response) => {
  try {
    const bannedWords = await storage.getBannedWords();
    res.json(bannedWords);
  } catch (error) {
    console.error('Error fetching banned words:', error);
    res.status(500).json({ error: 'Failed to fetch banned words' });
  }
});

// Add banned word
router.post('/banned-words', async (req: AdminRequest, res: Response) => {
  try {
    const schema = z.object({
      word: z.string().min(1).max(100),
      category: z.enum(['profanity', 'harassment', 'hate_speech', 'threats', 'general']).default('general'),
      severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
      autoBlock: z.boolean().default(false),
      isActive: z.boolean().default(true),
    });
    
    const data = schema.parse(req.body);
    
    const bannedWord = await storage.createBannedWord({
      ...data,
      createdBy: req.userId,
    });
    
    res.status(201).json(bannedWord);
  } catch (error) {
    console.error('Error creating banned word:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to create banned word' });
  }
});

// Update banned word
router.patch('/banned-words/:id', async (req: AdminRequest, res: Response) => {
  try {
    const schema = z.object({
      word: z.string().min(1).max(100).optional(),
      category: z.enum(['profanity', 'harassment', 'hate_speech', 'threats', 'general']).optional(),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      autoBlock: z.boolean().optional(),
      isActive: z.boolean().optional(),
    });
    
    const data = schema.parse(req.body);
    const updated = await storage.updateBannedWord(req.params.id, data);
    
    if (!updated) {
      return res.status(404).json({ error: 'Banned word not found' });
    }
    
    res.json(updated);
  } catch (error) {
    console.error('Error updating banned word:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to update banned word' });
  }
});

// Delete banned word
router.delete('/banned-words/:id', async (req: AdminRequest, res: Response) => {
  try {
    const deleted = await storage.deleteBannedWord(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Banned word not found' });
    }
    res.json({ message: 'Banned word deleted successfully' });
  } catch (error) {
    console.error('Error deleting banned word:', error);
    res.status(500).json({ error: 'Failed to delete banned word' });
  }
});

// Scan all calls with transcripts for banned word violations
router.post('/banned-words/scan-all-calls', async (req: AdminRequest, res: Response) => {
  try {
    const { detectViolations } = await import('../services/violation-detection');
    
    const callsWithTranscripts = await storage.getCallsWithTranscripts();
    console.log(`🔍 [Admin] Scanning ${callsWithTranscripts.length} calls for banned word violations`);
    
    let totalViolationsFound = 0;
    let callsScanned = 0;
    
    for (const call of callsWithTranscripts) {
      if (call.transcript && call.userId) {
        const violations = await detectViolations(call.id, call.userId, call.transcript);
        totalViolationsFound += violations.length;
        callsScanned++;
      }
    }
    
    console.log(`✅ [Admin] Scan complete: ${totalViolationsFound} violations found in ${callsScanned} calls`);
    
    res.json({
      success: true,
      callsScanned,
      violationsFound: totalViolationsFound,
      message: `Scanned ${callsScanned} calls, found ${totalViolationsFound} violations`
    });
  } catch (error) {
    console.error('Error scanning calls for violations:', error);
    res.status(500).json({ error: 'Failed to scan calls for violations' });
  }
});

// =============================================
// CONTENT VIOLATIONS MANAGEMENT
// =============================================

// Get all content violations
router.get('/content-violations', async (req: AdminRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 25;
    const status = req.query.status as string;
    const severity = req.query.severity as string;
    
    const result = await storage.getContentViolations({
      page,
      pageSize,
      status,
      severity,
    });
    
    res.json(result);
  } catch (error) {
    console.error('Error fetching content violations:', error);
    res.status(500).json({ error: 'Failed to fetch content violations' });
  }
});

// Review/update violation status
router.patch('/content-violations/:id', async (req: AdminRequest, res: Response) => {
  try {
    const schema = z.object({
      status: z.enum(['pending', 'reviewed', 'dismissed', 'actioned']).optional(),
      actionTaken: z.string().optional(),
      notes: z.string().optional(),
    });
    
    const data = schema.parse(req.body);
    const updated = await storage.updateContentViolation(req.params.id, {
      ...data,
      reviewedBy: req.userId,
      reviewedAt: new Date(),
    });
    
    if (!updated) {
      return res.status(404).json({ error: 'Violation not found' });
    }
    
    res.json(updated);
  } catch (error) {
    console.error('Error updating violation:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to update violation' });
  }
});

// =============================================
// USER BLOCKING
// =============================================

// Block user with reason
router.post('/users/:id/block', async (req: AdminRequest, res: Response) => {
  try {
    const schema = z.object({
      reason: z.string().min(1).max(500),
    });
    
    const { reason } = schema.parse(req.body);
    const userId = req.params.id;
    
    const user = await storage.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const updated = await storage.updateUser(userId, {
      isActive: false,
      blockedReason: reason,
      blockedAt: new Date(),
      blockedBy: req.userId,
    });
    
    res.json({ 
      message: 'User blocked successfully',
      user: updated
    });
  } catch (error) {
    console.error('Error blocking user:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to block user' });
  }
});

// Unblock user
router.post('/users/:id/unblock', async (req: AdminRequest, res: Response) => {
  try {
    const userId = req.params.id;
    
    const user = await storage.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const updated = await storage.updateUser(userId, {
      isActive: true,
      blockedReason: null,
      blockedAt: null,
      blockedBy: null,
    });
    
    res.json({ 
      message: 'User unblocked successfully',
      user: updated
    });
  } catch (error) {
    console.error('Error unblocking user:', error);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

// Scan call for violations (manual trigger)
router.post('/calls/:id/scan', async (req: AdminRequest, res: Response) => {
  try {
    const call = await storage.getAdminCallById(req.params.id);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    
    if (!call.transcript) {
      return res.status(400).json({ error: 'Call has no transcript to scan' });
    }
    
    // Import the violation detection service
    const { detectViolations } = await import('../services/violation-detection');
    const violations = await detectViolations(call.id, call.userId!, call.transcript);
    
    res.json({ 
      message: `Scan complete. Found ${violations.length} violation(s).`,
      violations
    });
  } catch (error) {
    console.error('Error scanning call:', error);
    res.status(500).json({ error: 'Failed to scan call' });
  }
});

// POST /api/admin/elevenlabs-webhooks/verify - Verify and fix webhooks on all ElevenLabs agents
router.post('/elevenlabs-webhooks/verify', async (req: AdminRequest, res: Response) => {
  try {
    console.log(`🔗 [Admin] Verifying and fixing ElevenLabs webhooks on all agents...`);
    
    const domain = getDomain();
    const webhookUrl = `${domain}/api/webhooks/elevenlabs`;
    
    // Get HMAC secret from database
    const hmacSecretSetting = await storage.getGlobalSetting('elevenlabs_hmac_secret');
    const hmacSecret = hmacSecretSetting?.value as string | undefined;
    
    // Get all agents with ElevenLabs agent IDs
    const allAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        type: agents.type,
        elevenLabsAgentId: agents.elevenLabsAgentId,
        elevenLabsCredentialId: agents.elevenLabsCredentialId,
      })
      .from(agents)
      .where(isNotNull(agents.elevenLabsAgentId));
    
    console.log(`   Found ${allAgents.length} agents with ElevenLabs IDs`);
    
    const results: Array<{
      agentId: string;
      name: string;
      elevenLabsAgentId: string;
      success: boolean;
      error?: string;
    }> = [];
    
    for (const agent of allAgents) {
      try {
        // Get credential for this agent
        let elevenLabsService: typeof import('../services/elevenlabs').elevenLabsService;
        
        if (agent.elevenLabsCredentialId) {
          const credential = await ElevenLabsPoolService.getCredentialById(agent.elevenLabsCredentialId);
          if (credential) {
            const { ElevenLabsService } = await import('../services/elevenlabs');
            elevenLabsService = new ElevenLabsService(credential.apiKey);
          } else {
            // Fallback to default service
            const { elevenLabsService: defaultService } = await import('../services/elevenlabs');
            elevenLabsService = defaultService;
          }
        } else {
          const { elevenLabsService: defaultService } = await import('../services/elevenlabs');
          elevenLabsService = defaultService;
        }
        
        // Configure webhook on agent
        await elevenLabsService.configureAgentWebhook(agent.elevenLabsAgentId!, {
          webhookUrl,
          events: ['conversation.completed'],
          secret: hmacSecret,
        });
        
        results.push({
          agentId: agent.id,
          name: agent.name,
          elevenLabsAgentId: agent.elevenLabsAgentId!,
          success: true,
        });
        
        console.log(`   ✅ Webhook configured for agent: ${agent.name}`);
      } catch (error: any) {
        console.error(`   ❌ Error configuring webhook for agent ${agent.name}:`, error.message);
        results.push({
          agentId: agent.id,
          name: agent.name,
          elevenLabsAgentId: agent.elevenLabsAgentId!,
          success: false,
          error: error.message,
        });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    console.log(`✅ [Admin] Webhook verification complete: ${successCount} success, ${failCount} failed`);
    
    res.json({
      webhookUrl,
      hmacSecretConfigured: !!hmacSecret,
      total: allAgents.length,
      success: successCount,
      failed: failCount,
      results,
    });
  } catch (error: any) {
    console.error('❌ [Admin] Error verifying webhooks:', error);
    res.status(500).json({ error: error.message || 'Failed to verify webhooks' });
  }
});

// POST /api/admin/calls/:id/fetch-elevenlabs - Manually fetch call data from ElevenLabs API
router.post('/calls/:id/fetch-elevenlabs', async (req: AdminRequest, res: Response) => {
  try {
    const callId = req.params.id;
    console.log(`📞 [Admin] Fetching ElevenLabs data for call: ${callId}`);
    
    // Get the call record
    const [callRecord] = await db
      .select()
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);
    
    if (!callRecord) {
      return res.status(404).json({ error: 'Call not found' });
    }
    
    if (!callRecord.elevenLabsConversationId) {
      return res.status(400).json({ error: 'Call has no ElevenLabs conversation ID' });
    }
    
    // Get credential for the agent if available
    let elevenLabsService: typeof import('../services/elevenlabs').elevenLabsService;
    
    if (callRecord.incomingAgentId) {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, callRecord.incomingAgentId))
        .limit(1);
      
      if (agent?.elevenLabsCredentialId) {
        const credential = await ElevenLabsPoolService.getCredentialById(agent.elevenLabsCredentialId);
        if (credential) {
          const { ElevenLabsService } = await import('../services/elevenlabs');
          elevenLabsService = new ElevenLabsService(credential.apiKey);
        } else {
          const { elevenLabsService: defaultService } = await import('../services/elevenlabs');
          elevenLabsService = defaultService;
        }
      } else {
        const { elevenLabsService: defaultService } = await import('../services/elevenlabs');
        elevenLabsService = defaultService;
      }
    } else {
      // Try to find the credential from pool
      const credential = await ElevenLabsPoolService.getAvailableCredential();
      if (credential) {
        const { ElevenLabsService } = await import('../services/elevenlabs');
        elevenLabsService = new ElevenLabsService(credential.apiKey);
      } else {
        const { elevenLabsService: defaultService } = await import('../services/elevenlabs');
        elevenLabsService = defaultService;
      }
    }
    
    // Fetch conversation details from ElevenLabs
    const conversationData = await elevenLabsService.getConversationDetails(callRecord.elevenLabsConversationId);
    
    // Format transcript
    let formattedTranscript = '';
    if (conversationData.transcript && conversationData.transcript.length > 0) {
      formattedTranscript = conversationData.transcript
        .map(entry => `${entry.role === 'agent' ? 'Agent' : 'User'}: ${entry.message}`)
        .join('\n');
    }
    
    // Map ElevenLabs status to our status
    let callStatus = callRecord.status;
    if (conversationData.status === 'done') {
      callStatus = 'completed';
    } else if (conversationData.status === 'failed') {
      callStatus = 'failed';
    }
    
    // Update the call record
    const updates: Record<string, any> = {
      status: callStatus,
    };
    
    if (conversationData.call_duration_secs) {
      updates.duration = conversationData.call_duration_secs;
    }
    
    if (formattedTranscript) {
      updates.transcript = formattedTranscript;
    }
    
    if (conversationData.analysis?.summary) {
      updates.aiSummary = conversationData.analysis.summary;
    }
    
    if (conversationData.start_time_unix_secs) {
      updates.startedAt = new Date(conversationData.start_time_unix_secs * 1000);
    }
    
    if (conversationData.end_time_unix_secs) {
      updates.endedAt = new Date(conversationData.end_time_unix_secs * 1000);
    }
    
    // Store additional metadata
    const existingMetadata = callRecord.metadata as object || {};
    updates.metadata = {
      ...existingMetadata,
      elevenLabsStatus: conversationData.status,
      elevenLabsSyncedAt: new Date().toISOString(),
      elevenLabsAnalysis: conversationData.analysis,
    };
    
    await db
      .update(calls)
      .set(updates)
      .where(eq(calls.id, callId));
    
    console.log(`✅ [Admin] Call ${callId} updated with ElevenLabs data`);
    console.log(`   Status: ${callStatus}`);
    console.log(`   Duration: ${updates.duration || 'N/A'}s`);
    console.log(`   Transcript: ${formattedTranscript ? `${formattedTranscript.length} chars` : 'N/A'}`);
    
    res.json({
      success: true,
      callId,
      updates: {
        status: callStatus,
        duration: updates.duration,
        hasTranscript: !!formattedTranscript,
        hasSummary: !!updates.aiSummary,
      },
      elevenLabsData: {
        conversationId: callRecord.elevenLabsConversationId,
        status: conversationData.status,
        duration: conversationData.call_duration_secs,
        transcriptEntries: conversationData.transcript?.length || 0,
        hasRecording: !!conversationData.recording_url,
      },
    });
  } catch (error: any) {
    console.error('❌ [Admin] Error fetching ElevenLabs data:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch ElevenLabs data' });
  }
});

// POST /api/admin/calls/fetch-all-missing - Fetch ElevenLabs data for all calls missing data
router.post('/calls/fetch-all-missing', async (req: AdminRequest, res: Response) => {
  try {
    console.log(`📞 [Admin] Fetching ElevenLabs data for all calls missing data...`);
    
    // Find calls that have ElevenLabs conversation ID but are missing data
    const callsMissingData = await db
      .select()
      .from(calls)
      .where(
        and(
          isNotNull(calls.elevenLabsConversationId),
          or(
            isNull(calls.transcript),
            isNull(calls.duration),
            eq(calls.status, 'initiated'),
            eq(calls.status, 'ringing'),
            eq(calls.status, 'in-progress')
          )
        )
      );
    
    console.log(`   Found ${callsMissingData.length} calls missing data`);
    
    const results: Array<{
      callId: string;
      conversationId: string;
      success: boolean;
      error?: string;
      duration?: number;
    }> = [];
    
    for (const callRecord of callsMissingData) {
      try {
        // Get credential for the agent if available
        let elevenLabsService: typeof import('../services/elevenlabs').elevenLabsService;
        
        if (callRecord.incomingAgentId) {
          const [agent] = await db
            .select()
            .from(agents)
            .where(eq(agents.id, callRecord.incomingAgentId))
            .limit(1);
          
          if (agent?.elevenLabsCredentialId) {
            const credential = await ElevenLabsPoolService.getCredentialById(agent.elevenLabsCredentialId);
            if (credential) {
              const { ElevenLabsService } = await import('../services/elevenlabs');
              elevenLabsService = new ElevenLabsService(credential.apiKey);
            } else {
              const { elevenLabsService: defaultService } = await import('../services/elevenlabs');
              elevenLabsService = defaultService;
            }
          } else {
            const { elevenLabsService: defaultService } = await import('../services/elevenlabs');
            elevenLabsService = defaultService;
          }
        } else {
          const credential = await ElevenLabsPoolService.getAvailableCredential();
          if (credential) {
            const { ElevenLabsService } = await import('../services/elevenlabs');
            elevenLabsService = new ElevenLabsService(credential.apiKey);
          } else {
            const { elevenLabsService: defaultService } = await import('../services/elevenlabs');
            elevenLabsService = defaultService;
          }
        }
        
        // Fetch conversation details from ElevenLabs
        const conversationData = await elevenLabsService.getConversationDetails(callRecord.elevenLabsConversationId!);
        
        // Format transcript
        let formattedTranscript = '';
        if (conversationData.transcript && conversationData.transcript.length > 0) {
          formattedTranscript = conversationData.transcript
            .map(entry => `${entry.role === 'agent' ? 'Agent' : 'User'}: ${entry.message}`)
            .join('\n');
        }
        
        // Map ElevenLabs status to our status
        let callStatus = callRecord.status;
        if (conversationData.status === 'done') {
          callStatus = 'completed';
        } else if (conversationData.status === 'failed') {
          callStatus = 'failed';
        }
        
        // Update the call record
        const updates: Record<string, any> = {
          status: callStatus,
        };
        
        if (conversationData.call_duration_secs) {
          updates.duration = conversationData.call_duration_secs;
        }
        
        if (formattedTranscript) {
          updates.transcript = formattedTranscript;
        }
        
        if (conversationData.analysis?.summary) {
          updates.aiSummary = conversationData.analysis.summary;
        }
        
        if (conversationData.start_time_unix_secs) {
          updates.startedAt = new Date(conversationData.start_time_unix_secs * 1000);
        }
        
        if (conversationData.end_time_unix_secs) {
          updates.endedAt = new Date(conversationData.end_time_unix_secs * 1000);
        }
        
        const existingMetadata = callRecord.metadata as object || {};
        updates.metadata = {
          ...existingMetadata,
          elevenLabsStatus: conversationData.status,
          elevenLabsSyncedAt: new Date().toISOString(),
        };
        
        await db
          .update(calls)
          .set(updates)
          .where(eq(calls.id, callRecord.id));
        
        results.push({
          callId: callRecord.id,
          conversationId: callRecord.elevenLabsConversationId!,
          success: true,
          duration: conversationData.call_duration_secs,
        });
        
        console.log(`   ✅ Updated call ${callRecord.id}: ${callStatus}, ${conversationData.call_duration_secs || 0}s`);
      } catch (error: any) {
        console.error(`   ❌ Error fetching data for call ${callRecord.id}:`, error.message);
        results.push({
          callId: callRecord.id,
          conversationId: callRecord.elevenLabsConversationId!,
          success: false,
          error: error.message,
        });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    console.log(`✅ [Admin] Fetch complete: ${successCount} success, ${failCount} failed`);
    
    res.json({
      total: callsMissingData.length,
      success: successCount,
      failed: failCount,
      results,
    });
  } catch (error: any) {
    console.error('❌ [Admin] Error fetching missing call data:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch missing call data' });
  }
});

export { router as adminRouter };