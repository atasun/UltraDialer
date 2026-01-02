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

import { db } from "./db";
import { llmModels, plans, creditPackages, promptTemplates, flows, emailTemplates, globalSettings, supportedLanguages, type FlowNode, type FlowEdge } from "@shared/schema";
import { sql } from "drizzle-orm";

import { MODELS_SEED_DATA } from "./seed-llm-models-data";
import { PLANS_SEED_DATA } from "./seed-plans";
import { CREDIT_PACKAGES_SEED_DATA } from "./seed-credit-packages";
import { PROMPT_TEMPLATES_SEED_DATA } from "./seed-prompt-templates";
import { EMAIL_TEMPLATES_SEED_DATA } from "./seed-email-templates";
import { AGENT_TEMPLATES_SEED_DATA } from "./seed-agent-templates";
import { GLOBAL_SETTINGS_SEED_DATA } from "./seed-global-settings";
import { SEO_SETTINGS_SEED_DATA } from "./seed-seo-settings";
import { TWILIO_COUNTRIES_SEED_DATA, seedTwilioCountries } from "./seed-twilio-countries";
import { LANGUAGES_SEED_DATA } from "./seed-languages";
import { flowTemplates } from "./services/flow-templates";

const SYSTEM_USER_ID = "system";

async function seedLlmModels() {
  console.log("\n📊 Seeding LLM Models...");
  const existing = await db.select().from(llmModels);
  if (existing.length > 0) {
    console.log(`   ⚠️  Found ${existing.length} existing models. Skipping.`);
    return;
  }
  await db.insert(llmModels).values(MODELS_SEED_DATA);
  console.log(`   ✅ Inserted ${MODELS_SEED_DATA.length} LLM models`);
  console.log(`      - Free tier: ${MODELS_SEED_DATA.filter((m: { tier: string }) => m.tier === 'free').length}`);
  console.log(`      - Pro tier: ${MODELS_SEED_DATA.filter((m: { tier: string }) => m.tier === 'pro').length}`);
}

async function seedPlans() {
  console.log("\n💳 Seeding Subscription Plans...");
  const existing = await db.select().from(plans);
  if (existing.length > 0) {
    console.log(`   ⚠️  Found ${existing.length} existing plans. Skipping.`);
    return;
  }
  await db.insert(plans).values(PLANS_SEED_DATA);
  console.log(`   ✅ Inserted ${PLANS_SEED_DATA.length} subscription plans`);
  PLANS_SEED_DATA.forEach(p => {
    console.log(`      - ${p.displayName}: $${p.monthlyPrice}/month, ${p.includedCredits} credits`);
  });
}

async function seedCreditPackages() {
  console.log("\n🪙 Seeding Credit Packages...");
  const existing = await db.select().from(creditPackages);
  if (existing.length > 0) {
    console.log(`   ⚠️  Found ${existing.length} existing packages. Skipping.`);
    return;
  }
  await db.insert(creditPackages).values(CREDIT_PACKAGES_SEED_DATA);
  console.log(`   ✅ Inserted ${CREDIT_PACKAGES_SEED_DATA.length} credit packages`);
  CREDIT_PACKAGES_SEED_DATA.forEach(pkg => {
    console.log(`      - ${pkg.name}: ${pkg.credits} credits @ $${pkg.price}`);
  });
}

async function seedPromptTemplates() {
  console.log("\n📝 Seeding Prompt Templates...");
  const existing = await db.select().from(promptTemplates);
  const systemTemplates = existing.filter(t => t.isSystemTemplate);
  if (systemTemplates.length > 0) {
    console.log(`   ⚠️  Found ${systemTemplates.length} existing system templates. Skipping.`);
    return;
  }
  await db.insert(promptTemplates).values(PROMPT_TEMPLATES_SEED_DATA);
  console.log(`   ✅ Inserted ${PROMPT_TEMPLATES_SEED_DATA.length} prompt templates`);
  const categories = ['sales', 'support', 'appointment', 'survey', 'general'];
  categories.forEach(cat => {
    const count = PROMPT_TEMPLATES_SEED_DATA.filter(t => t.category === cat).length;
    console.log(`      - ${cat}: ${count} templates`);
  });
}

async function seedFlowTemplates() {
  console.log("\n🔄 Seeding Flow Templates...");
  const existing = await db.select().from(flows);
  const existingTemplates = existing.filter(f => f.isTemplate);
  if (existingTemplates.length > 0) {
    console.log(`   ⚠️  Found ${existingTemplates.length} existing flow templates. Skipping.`);
    return;
  }
  
  const flowsToInsert = flowTemplates.map(template => ({
    id: template.id,
    userId: SYSTEM_USER_ID,
    name: template.name,
    description: template.description,
    nodes: template.nodes as FlowNode[],
    edges: template.edges as FlowEdge[],
    isTemplate: true,
    isActive: true,
  }));
  
  await db.insert(flows).values(flowsToInsert);
  console.log(`   ✅ Inserted ${flowTemplates.length} flow templates`);
  flowTemplates.forEach(t => {
    console.log(`      - ${t.name}: ${t.nodes.length} nodes`);
  });
}

async function seedEmailTemplates() {
  console.log("\n📧 Seeding Email Templates...");
  const existing = await db.select().from(emailTemplates);
  const existingTypes = existing.map(t => t.templateType);
  
  const templatesToInsert = EMAIL_TEMPLATES_SEED_DATA.filter(
    template => !existingTypes.includes(template.templateType)
  );
  
  if (templatesToInsert.length === 0) {
    console.log(`   ⚠️  All ${EMAIL_TEMPLATES_SEED_DATA.length} email templates already exist. Skipping.`);
    return;
  }

  await db.insert(emailTemplates).values(templatesToInsert);
  console.log(`   ✅ Inserted ${templatesToInsert.length} email templates`);
  templatesToInsert.forEach(template => {
    console.log(`      - ${template.name} (${template.templateType}): ${template.variables.length} variables`);
  });
}

async function seedAgentTemplates() {
  console.log("\n🤖 Seeding Agent Templates...");
  const existing = await db.select().from(promptTemplates);
  const agentPresets = existing.filter(t => t.category === "agent_preset" && t.isSystemTemplate);
  
  if (agentPresets.length > 0) {
    console.log(`   ⚠️  Found ${agentPresets.length} existing agent preset templates. Skipping.`);
    return;
  }

  await db.insert(promptTemplates).values(AGENT_TEMPLATES_SEED_DATA);
  console.log(`   ✅ Inserted ${AGENT_TEMPLATES_SEED_DATA.length} agent preset templates`);
  AGENT_TEMPLATES_SEED_DATA.forEach(template => {
    console.log(`      - ${template.name}`);
  });
}

async function seedGlobalSettings() {
  console.log("\n⚙️  Seeding Global Settings...");
  const existing = await db.select().from(globalSettings);
  const existingKeys = existing.map(s => s.key);
  
  const settingsToInsert = GLOBAL_SETTINGS_SEED_DATA.filter(
    setting => !existingKeys.includes(setting.key)
  );
  
  if (settingsToInsert.length === 0) {
    console.log(`   ⚠️  All ${GLOBAL_SETTINGS_SEED_DATA.length} global settings already exist. Skipping.`);
    return;
  }

  for (const setting of settingsToInsert) {
    await db.execute(sql`
      INSERT INTO global_settings (id, key, value, description, updated_at)
      VALUES (gen_random_uuid(), ${setting.key}, ${JSON.stringify(setting.value)}::jsonb, ${setting.description}, NOW())
      ON CONFLICT (key) DO NOTHING
    `);
  }
  console.log(`   ✅ Inserted ${settingsToInsert.length} global settings`);
  
  const categories = {
    "Branding": settingsToInsert.filter(s => s.key.startsWith("company_")).length,
    "Features": settingsToInsert.filter(s => s.key.startsWith("feature_")).length,
    "Credits": settingsToInsert.filter(s => s.key.includes("credit") || s.key.includes("currency")).length,
    "Campaigns": settingsToInsert.filter(s => s.key.startsWith("campaign_")).length,
    "Security": settingsToInsert.filter(s => s.key.includes("password") || s.key.includes("login") || s.key.includes("session")).length,
  };
  
  Object.entries(categories).forEach(([category, count]) => {
    if (count > 0) {
      console.log(`      - ${category}: ${count} settings`);
    }
  });
}

async function seedSeoSettings() {
  console.log("\n🔍 Seeding SEO Settings...");
  const existing = await db.select().from(globalSettings);
  const existingKeys = existing.map(s => s.key);
  
  const settingsToInsert = SEO_SETTINGS_SEED_DATA.filter(
    setting => !existingKeys.includes(setting.key)
  );
  
  if (settingsToInsert.length === 0) {
    console.log(`   ⚠️  All ${SEO_SETTINGS_SEED_DATA.length} SEO settings already exist. Skipping.`);
    return;
  }

  for (const setting of settingsToInsert) {
    await db.execute(sql`
      INSERT INTO global_settings (id, key, value, description, updated_at)
      VALUES (gen_random_uuid(), ${setting.key}, ${JSON.stringify(setting.value)}::jsonb, ${setting.description}, NOW())
      ON CONFLICT (key) DO NOTHING
    `);
  }
  console.log(`   ✅ Inserted ${settingsToInsert.length} SEO settings`);
  
  const categories = {
    "Meta Tags": settingsToInsert.filter(s => s.key.includes("_title") || s.key.includes("_description")).length,
    "Open Graph": settingsToInsert.filter(s => s.key.includes("_og_")).length,
    "Twitter": settingsToInsert.filter(s => s.key.includes("_twitter_")).length,
    "Robots & Sitemap": settingsToInsert.filter(s => s.key.includes("_robots") || s.key.includes("_sitemap")).length,
    "Analytics": settingsToInsert.filter(s => s.key.includes("_google_") || s.key.includes("_facebook_")).length,
  };
  
  Object.entries(categories).forEach(([category, count]) => {
    if (count > 0) {
      console.log(`      - ${category}: ${count} settings`);
    }
  });
}

async function seedLanguages() {
  console.log("\n🌍 Seeding Supported Languages...");
  const existing = await db.select().from(supportedLanguages);
  if (existing.length > 0) {
    console.log(`   ⚠️  Found ${existing.length} existing languages. Skipping.`);
    return;
  }
  await db.insert(supportedLanguages).values(LANGUAGES_SEED_DATA);
  console.log(`   ✅ Inserted ${LANGUAGES_SEED_DATA.length} supported languages`);
  const bothCount = LANGUAGES_SEED_DATA.filter((l: { providers: string }) => l.providers === 'both').length;
  const openaiOnlyCount = LANGUAGES_SEED_DATA.filter((l: { providers: string }) => l.providers === 'openai').length;
  console.log(`      - Both providers: ${bothCount} languages`);
  console.log(`      - OpenAI only: ${openaiOnlyCount} languages`);
}

const SEED_VERSION = "1.0.0";

async function updateSeedVersion() {
  console.log("\n📌 Updating seed version tracking...");
  await db.execute(sql`
    UPDATE global_settings 
    SET value = ${JSON.stringify(SEED_VERSION)}::jsonb, updated_at = NOW()
    WHERE key = 'seed_version'
  `);
  await db.execute(sql`
    UPDATE global_settings 
    SET value = ${JSON.stringify(new Date().toISOString())}::jsonb, updated_at = NOW()
    WHERE key = 'seed_applied_at'
  `);
  console.log(`   ✅ Seed version: ${SEED_VERSION}`);
}

export async function runAllSeedsForInstaller(): Promise<{
  success: boolean;
  summary: Record<string, number>;
  error?: string;
}> {
  console.log("🌱 [Installer] Running database seeds...");
  
  const summary: Record<string, number> = {};
  
  try {
    await seedLlmModels();
    summary.llmModels = MODELS_SEED_DATA.length;
    
    await seedPlans();
    summary.plans = PLANS_SEED_DATA.length;
    
    await seedCreditPackages();
    summary.creditPackages = CREDIT_PACKAGES_SEED_DATA.length;
    
    await seedPromptTemplates();
    summary.promptTemplates = PROMPT_TEMPLATES_SEED_DATA.length;
    
    await seedAgentTemplates();
    summary.agentTemplates = AGENT_TEMPLATES_SEED_DATA.length;
    
    await seedFlowTemplates();
    summary.flowTemplates = flowTemplates.length;
    
    await seedEmailTemplates();
    summary.emailTemplates = EMAIL_TEMPLATES_SEED_DATA.length;
    
    await seedGlobalSettings();
    summary.globalSettings = GLOBAL_SETTINGS_SEED_DATA.length;
    
    await seedSeoSettings();
    summary.seoSettings = SEO_SETTINGS_SEED_DATA.length;
    
    await seedLanguages();
    summary.languages = LANGUAGES_SEED_DATA.length;
    
    await seedTwilioCountries();
    summary.twilioCountries = TWILIO_COUNTRIES_SEED_DATA.length;
    
    await updateSeedVersion();
    
    console.log("✅ [Installer] All seeds completed successfully");
    console.log(`   Summary: ${JSON.stringify(summary)}`);
    
    return { success: true, summary };
  } catch (error: any) {
    console.error("❌ [Installer] Seeding failed:", error);
    return { success: false, summary, error: error.message };
  }
}

async function runAllSeeds() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║           🌱 AgentLabs Database Seeder                     ║");
  console.log("║           © 2025 Diploy - Bisht Technologies               ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  
  try {
    await seedLlmModels();
    await seedPlans();
    await seedCreditPackages();
    await seedPromptTemplates();
    await seedAgentTemplates();
    await seedFlowTemplates();
    await seedEmailTemplates();
    await seedGlobalSettings();
    await seedSeoSettings();
    await seedLanguages();
    await seedTwilioCountries();
    await updateSeedVersion();
    
    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║           🎉 All Seeds Completed Successfully!            ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log("\n📋 Seed Summary:");
    console.log("   - LLM Models: Up to 14 models (Free + Pro tiers)");
    console.log("   - Subscription Plans: Free & Pro plans");
    console.log("   - Credit Packages: 6 packages ($9.99 - $699.99)");
    console.log("   - Prompt Templates: 15 professional templates");
    console.log("   - Agent Templates: 8 agent presets");
    console.log("   - Flow Templates: 8 automation flows");
    console.log("   - Email Templates: 8 transactional emails");
    console.log("   - Global Settings: Platform configuration");
    console.log("   - SEO Settings: Meta tags & analytics");
    console.log(`   - Supported Languages: ${LANGUAGES_SEED_DATA.length} languages with provider support`);
    console.log(`   - Twilio Countries: ${TWILIO_COUNTRIES_SEED_DATA.length} countries for phone number purchasing`);
    console.log(`   - Seed Version: ${SEED_VERSION}\n`);
    
  } catch (error) {
    console.error("\n❌ Seeding failed:", error);
    throw error;
  }
}

import { fileURLToPath } from 'url';

const isDirectExecution = process.argv[1]?.includes('seed-all') || 
  (typeof import.meta.url !== 'undefined' && 
   process.argv[1] === fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runAllSeeds()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Fatal error:", error);
      process.exit(1);
    });
}
