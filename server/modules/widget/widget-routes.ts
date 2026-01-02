import { Router, Request, Response } from "express";
import { widgetService } from "./widget-service";
import { widgetStorage } from "./widget-storage";
import { insertWebsiteWidgetSchema } from "@shared/schema";
import { z } from "zod";
import multer from "multer";
import path from "path";
import fs from "fs";

const allowedUpdateFields = [
  'name', 'description', 'status', 'agentId', 'agentType',
  'iconUrl', 'iconPath', 'brandName', 'buttonLabel', 'primaryColor', 'accentColor', 
  'backgroundColor', 'textColor', 'welcomeMessage', 'launcherText',
  'offlineMessage', 'lowCreditsMessage', 'allowedDomains',
  'businessHoursEnabled', 'businessHoursStart', 'businessHoursEnd',
  'businessDays', 'businessTimezone', 'maxConcurrentCalls', 'maxCallDuration',
  'requireTermsAcceptance'
] as const;

function sanitizeWidgetData(data: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const field of allowedUpdateFields) {
    if (data[field] !== undefined) {
      sanitized[field] = data[field];
    }
  }
  return sanitized;
}

const router = Router();

const uploadDir = path.join(process.cwd(), 'client', 'public', 'uploads', 'widgets');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'widget-icon-' + uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PNG, JPEG, SVG, and WebP are allowed.'));
    }
  },
});

function requireAuth(req: Request, res: Response, next: any) {
  if (!(req as any).user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

router.get('/widgets', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const widgets = await widgetService.getWidgetsByUser(userId);
    res.json(widgets);
  } catch (error) {
    console.error('Error fetching widgets:', error);
    res.status(500).json({ error: 'Failed to fetch widgets' });
  }
});

router.get('/widgets/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const widget = await widgetService.getWidgetById(req.params.id, userId);
    if (!widget) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    res.json(widget);
  } catch (error) {
    console.error('Error fetching widget:', error);
    res.status(500).json({ error: 'Failed to fetch widget' });
  }
});

function parseFormData(body: Record<string, any>): Record<string, any> {
  const parsed: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(body)) {
    if (value === '' || value === undefined) continue;
    
    if (key === 'allowedDomains' || key === 'businessDays') {
      try {
        parsed[key] = typeof value === 'string' ? JSON.parse(value) : value;
      } catch {
        parsed[key] = [];
      }
    } else if (key === 'businessHoursEnabled' || key === 'requireTermsAcceptance') {
      parsed[key] = value === 'true' || value === true;
    } else if (key === 'maxConcurrentCalls' || key === 'maxCallDuration') {
      parsed[key] = parseInt(value) || (key === 'maxConcurrentCalls' ? 5 : 300);
    } else if (key === 'agentId') {
      parsed[key] = value && value !== '' && value !== 'none' ? value : null;
    } else {
      parsed[key] = value;
    }
  }
  
  return parsed;
}

router.post('/widgets', requireAuth, upload.single('icon'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const parsedData = parseFormData(req.body);
    const sanitizedData = sanitizeWidgetData(parsedData);
    
    if (!sanitizedData.name || typeof sanitizedData.name !== 'string' || sanitizedData.name.trim().length === 0) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Widget name is required' });
    }
    
    const limitCheck = await widgetService.checkWidgetLimit(userId);
    if (!limitCheck.allowed) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(403).json({ 
        error: 'Widget limit reached', 
        message: `Your plan allows ${limitCheck.maxWidgets} widget(s). You have ${limitCheck.currentCount} widget(s).`,
        currentCount: limitCheck.currentCount,
        maxWidgets: limitCheck.maxWidgets
      });
    }
    
    if (req.file) {
      sanitizedData.iconPath = `/uploads/widgets/${req.file.filename}`;
    }
    
    const widgetData = {
      name: sanitizedData.name as string,
      ...sanitizedData
    };
    
    const widget = await widgetService.createWidget(userId, widgetData);
    res.status(201).json(widget);
  } catch (error) {
    console.error('Error creating widget:', error);
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: 'Failed to create widget' });
  }
});

router.patch('/widgets/:id', requireAuth, upload.single('icon'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const parsedData = parseFormData(req.body);
    const sanitizedData = sanitizeWidgetData(parsedData);
    
    if (req.file) {
      sanitizedData.iconPath = `/uploads/widgets/${req.file.filename}`;
    }
    
    if (Object.keys(sanitizedData).length === 0) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    
    const widget = await widgetService.updateWidget(req.params.id, userId, sanitizedData);
    if (!widget) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Widget not found' });
    }
    res.json(widget);
  } catch (error) {
    console.error('Error updating widget:', error);
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: 'Failed to update widget' });
  }
});

router.delete('/widgets/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const deleted = await widgetService.deleteWidget(req.params.id, userId);
    if (!deleted) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting widget:', error);
    res.status(500).json({ error: 'Failed to delete widget' });
  }
});

router.post('/widgets/:id/regenerate-token', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const widget = await widgetService.regenerateEmbedToken(req.params.id, userId);
    if (!widget) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    res.json({ embedToken: widget.embedToken });
  } catch (error) {
    console.error('Error regenerating token:', error);
    res.status(500).json({ error: 'Failed to regenerate token' });
  }
});

router.post('/widgets/:id/icon', requireAuth, upload.single('icon'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const iconUrl = `/uploads/widgets/${file.filename}`;
    const widget = await widgetService.updateWidget(req.params.id, userId, { iconUrl });
    
    if (!widget) {
      fs.unlinkSync(file.path);
      return res.status(404).json({ error: 'Widget not found' });
    }
    
    res.json({ iconUrl });
  } catch (error) {
    console.error('Error uploading icon:', error);
    res.status(500).json({ error: 'Failed to upload icon' });
  }
});

router.get('/widgets/:id/embed-code', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const widget = await widgetService.getWidgetById(req.params.id, userId);
    
    if (!widget) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${protocol}://${host}`;
    
    const embedCode = widgetService.generateEmbedCode(widget, baseUrl);
    res.json({ embedCode });
  } catch (error) {
    console.error('Error generating embed code:', error);
    res.status(500).json({ error: 'Failed to generate embed code' });
  }
});

router.get('/widgets/:id/sessions', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const widget = await widgetService.getWidgetById(req.params.id, userId);
    
    if (!widget) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    
    const limit = parseInt(req.query.limit as string) || 50;
    const sessions = await widgetStorage.getSessionsByWidgetId(req.params.id, limit);
    res.json(sessions);
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

router.get('/widgets-stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const stats = await widgetService.getWidgetStats(userId);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching widget stats:', error);
    res.status(500).json({ error: 'Failed to fetch widget stats' });
  }
});

router.get('/widgets-limits', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const limits = await widgetService.getWidgetLimits(userId);
    res.json(limits);
  } catch (error) {
    console.error('Error fetching widget limits:', error);
    res.status(500).json({ error: 'Failed to fetch widget limits' });
  }
});

export default router;
