/**
 * ============================================================
 * Plugin Management Routes
 * 
 * Admin routes for viewing and managing installed plugins.
 * User routes for checking plugin availability/capabilities.
 * ============================================================
 */

import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { 
  discoverPlugins, 
  getPluginStatus, 
  setPluginEnabled, 
  getPluginManifest,
  getPlugin
} from '../plugins/loader';
import { getUserPlanCapabilities } from '../services/membership-service';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginsDir = path.resolve(__dirname, '../../plugins');

const router = Router();

/**
 * User-accessible endpoint for plugin capabilities
 * This router can be mounted without admin auth
 */
export const userPluginRouter = Router();

/**
 * GET /api/plugins/capabilities
 * Returns which plugins are enabled (user-safe, no sensitive data)
 * This is used by the frontend to conditionally show plugin-dependent UI
 * 
 * Now also checks user's plan to determine if they have SIP access
 */
userPluginRouter.get('/capabilities', async (req, res) => {
  try {
    const plugins = await getPluginStatus();
    
    const capabilities: Record<string, boolean> = {};
    const pluginBundles: Record<string, string> = {};
    
    for (const plugin of plugins) {
      if (plugin.enabled && plugin.registered) {
        capabilities[plugin.name] = true;
        // If plugin has a frontend bundle, include its URL
        // Use /bundle (without .js) to avoid Vite middleware transformation
        if (plugin.hasFrontendBundle) {
          pluginBundles[plugin.name] = `/api/plugins/${plugin.name}/bundle`;
        }
      }
    }
    
    // Check if SIP Engine plugin is globally enabled
    const sipPluginEnabled = capabilities['sip-engine'] ?? false;
    
    // Check if user has SIP access via their plan
    let userHasSipAccess = false;
    let sipEnginesAllowed: string[] = [];
    let maxConcurrentSipCalls = 0;
    
    // Get user's plan capabilities if authenticated
    const userId = (req as any).userId;
    if (userId && sipPluginEnabled) {
      try {
        const planCapabilities = await getUserPlanCapabilities(userId);
        userHasSipAccess = planCapabilities.sipEnabled;
        sipEnginesAllowed = planCapabilities.sipEnginesAllowed;
        maxConcurrentSipCalls = planCapabilities.maxConcurrentSipCalls;
      } catch (err) {
        console.warn('[Plugin Capabilities] Could not get user plan capabilities:', err);
      }
    }
    
    // SIP Engine is accessible only if plugin is enabled AND user's plan allows it
    const sipEngineAccess = sipPluginEnabled && userHasSipAccess;
    
    res.json({
      success: true,
      data: {
        capabilities,
        pluginBundles,
        sipEngine: sipEngineAccess,
        sipEnginesAllowed: sipEngineAccess ? sipEnginesAllowed : [],
        maxConcurrentSipCalls: sipEngineAccess ? maxConcurrentSipCalls : 0,
        restApi: capabilities['rest-api'] ?? false,
        teamManagement: capabilities['team-management'] ?? false,
      }
    });
  } catch (error: any) {
    console.error('[Plugin Capabilities] Error getting capabilities:', error);
    res.json({
      success: true,
      data: {
        capabilities: {},
        pluginBundles: {},
        sipEngine: false,
        sipEnginesAllowed: [],
        maxConcurrentSipCalls: 0,
        restApi: false,
        teamManagement: false,
      }
    });
  }
});

/**
 * Public router for serving plugin bundles
 * No authentication required - bundles are just JavaScript code
 * Plugin enabled status is still checked
 */
export const publicPluginRouter = Router();

/**
 * GET /api/plugins/:name/bundle.js or /api/plugins/:name/bundle
 * Serve the frontend bundle for a plugin (public access)
 * This allows plugins to self-register their UI components at runtime
 * Uses .bundle extension to prevent Vite middleware transformation
 */
publicPluginRouter.get('/:name/bundle', async (req, res) => {
  try {
    const { name } = req.params;
    const plugin = getPlugin(name);
    
    if (!plugin) {
      return res.status(404).json({
        success: false,
        error: 'Plugin not found',
      });
    }
    
    if (!plugin.enabled || !plugin.registered) {
      return res.status(403).json({
        success: false,
        error: 'Plugin is not enabled',
      });
    }
    
    const manifest = plugin.manifest;
    if (!manifest.ui?.frontendBundle) {
      return res.status(404).json({
        success: false,
        error: 'Plugin has no frontend bundle',
      });
    }
    
    const bundlePath = path.join(pluginsDir, name, manifest.ui.frontendBundle);
    
    if (!fs.existsSync(bundlePath)) {
      return res.status(404).json({
        success: false,
        error: 'Bundle file not found',
      });
    }
    
    // Read file content directly to prevent any middleware transformation
    const bundleContent = fs.readFileSync(bundlePath, 'utf-8');
    
    // Set headers to explicitly prevent Vite/middleware transformation
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('X-Vite-Skip', 'true');
    
    // Send raw content as string
    res.send(bundleContent);
    
  } catch (error: any) {
    console.error('[Plugin Routes] Error serving bundle:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to serve plugin bundle',
    });
  }
});

/**
 * GET /api/admin/plugins
 * List all installed plugins with their status
 */
router.get('/', async (req, res) => {
  try {
    const plugins = await getPluginStatus();
    
    res.json({
      success: true,
      data: {
        plugins,
        total: plugins.length,
        enabled: plugins.filter(p => p.enabled).length,
        registered: plugins.filter(p => p.registered).length,
      }
    });
  } catch (error: any) {
    console.error('[Plugin Routes] Error listing plugins:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list plugins',
      message: error.message,
    });
  }
});

/**
 * GET /api/admin/plugins/:name
 * Get details of a specific plugin
 */
router.get('/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const manifest = getPluginManifest(name);
    
    if (!manifest) {
      return res.status(404).json({
        success: false,
        error: 'Plugin not found',
        message: `Plugin '${name}' is not installed`,
      });
    }
    
    const status = (await getPluginStatus()).find(p => p.name === name);
    
    res.json({
      success: true,
      data: {
        ...manifest,
        enabled: status?.enabled ?? false,
        registered: status?.registered ?? false,
        error: status?.error,
      }
    });
  } catch (error: any) {
    console.error('[Plugin Routes] Error getting plugin:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get plugin details',
      message: error.message,
    });
  }
});

/**
 * PUT /api/admin/plugins/:name/enable
 * Enable a plugin
 */
router.put('/:name/enable', async (req, res) => {
  try {
    const { name } = req.params;
    const manifest = getPluginManifest(name);
    
    if (!manifest) {
      return res.status(404).json({
        success: false,
        error: 'Plugin not found',
        message: `Plugin '${name}' is not installed`,
      });
    }
    
    await setPluginEnabled(name, true);
    
    res.json({
      success: true,
      message: `Plugin '${manifest.displayName}' enabled. Restart the server to apply changes.`,
      data: {
        name,
        enabled: true,
        requiresRestart: true,
      }
    });
  } catch (error: any) {
    console.error('[Plugin Routes] Error enabling plugin:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to enable plugin',
      message: error.message,
    });
  }
});

/**
 * PUT /api/admin/plugins/:name/disable
 * Disable a plugin
 */
router.put('/:name/disable', async (req, res) => {
  try {
    const { name } = req.params;
    const manifest = getPluginManifest(name);
    
    if (!manifest) {
      return res.status(404).json({
        success: false,
        error: 'Plugin not found',
        message: `Plugin '${name}' is not installed`,
      });
    }
    
    await setPluginEnabled(name, false);
    
    res.json({
      success: true,
      message: `Plugin '${manifest.displayName}' disabled. Restart the server to apply changes.`,
      data: {
        name,
        enabled: false,
        requiresRestart: true,
      }
    });
  } catch (error: any) {
    console.error('[Plugin Routes] Error disabling plugin:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disable plugin',
      message: error.message,
    });
  }
});

/**
 * GET /api/admin/plugins/discover/available
 * Discover all available plugins (including disabled)
 */
router.get('/discover/available', async (req, res) => {
  try {
    const manifests = discoverPlugins();
    
    res.json({
      success: true,
      data: {
        plugins: manifests.map(m => ({
          name: m.name,
          displayName: m.displayName,
          version: m.version,
          description: m.description,
          author: m.author,
          features: m.features || [],
        })),
        total: manifests.length,
      }
    });
  } catch (error: any) {
    console.error('[Plugin Routes] Error discovering plugins:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to discover plugins',
      message: error.message,
    });
  }
});

export default router;
