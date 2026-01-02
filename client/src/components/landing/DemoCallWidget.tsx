import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Phone, 
  PhoneOff, 
  Mic, 
  MicOff, 
  Volume2,
  ChevronDown,
  X,
  Loader2,
  Timer,
  Globe
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";

interface DemoConfig {
  enabled: boolean;
  maxDuration: number;
  appName: string;
  languages: { code: string; name: string; nativeName: string }[];
  voices: { id: string; name: string; description: string; gender: string }[];
}

interface BrandingConfig {
  app_name: string;
  favicon_url: string;
  logo_url: string;
  logo_url_light: string;
  logo_url_dark: string;
}

const LANGUAGE_FLAGS: Record<string, string> = {
  en: '🇺🇸',
  es: '🇪🇸',
  fr: '🇫🇷',
  de: '🇩🇪',
  it: '🇮🇹',
  pt: '🇧🇷',
  zh: '🇨🇳',
  ja: '🇯🇵',
  ko: '🇰🇷',
  hi: '🇮🇳',
  ar: '🇸🇦',
  ru: '🇷🇺',
  nl: '🇳🇱',
  pl: '🇵🇱',
  sv: '🇸🇪',
  no: '🇳🇴',
  da: '🇩🇰',
  fi: '🇫🇮',
  el: '🇬🇷',
  cs: '🇨🇿',
  sk: '🇸🇰',
  hu: '🇭🇺',
  ro: '🇷🇴',
  bg: '🇧🇬',
  hr: '🇭🇷',
  uk: '🇺🇦',
  tr: '🇹🇷',
  id: '🇮🇩',
  ms: '🇲🇾',
  vi: '🇻🇳',
  fil: '🇵🇭',
  ta: '🇮🇳',
  th: '🇹🇭',
  he: '🇮🇱',
  bn: '🇧🇩',
  te: '🇮🇳',
  mr: '🇮🇳',
  gu: '🇮🇳',
  kn: '🇮🇳',
  ml: '🇮🇳',
  pa: '🇮🇳',
  ur: '🇵🇰',
  fa: '🇮🇷',
  sw: '🇰🇪',
  af: '🇿🇦',
  ca: '🇪🇸',
  lt: '🇱🇹',
  lv: '🇱🇻',
  sl: '🇸🇮',
  et: '🇪🇪',
};

export interface DemoCallWidgetRef {
  startCall: () => void;
}

interface DemoCallWidgetProps {
  className?: string;
}

export const DemoCallWidget = forwardRef<DemoCallWidgetRef, DemoCallWidgetProps>(({ className }, ref) => {
  const [isCallActive, setIsCallActive] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState('en');
  const [isLanguageOpen, setIsLanguageOpen] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(60);
  const [isConnecting, setIsConnecting] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  
  const { toast } = useToast();
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const demoSessionRef = useRef<{ id: string; token: string } | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioLevelIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const transcriptRef = useRef<string[]>([]);
  const languageDropdownRef = useRef<HTMLDivElement | null>(null);

  const { data: config, isLoading: configLoading } = useQuery<DemoConfig>({
    queryKey: ['/api/public/demo-config'],
    staleTime: 60000,
  });

  const { data: branding } = useQuery<BrandingConfig>({
    queryKey: ['/api/branding'],
    staleTime: 60000,
  });

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (languageDropdownRef.current && !languageDropdownRef.current.contains(event.target as Node)) {
        setIsLanguageOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const startCallRef = useRef<(() => void) | null>(null);

  const setupRemoteAudioAnalyser = (stream: MediaStream) => {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      audioLevelIntervalRef.current = setInterval(() => {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        setAudioLevel(Math.min(average / 128, 1));
      }, 50);
    } catch (e) {
      console.log('Could not set up audio analyser:', e);
    }
  };

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (audioLevelIntervalRef.current) {
      clearInterval(audioLevelIntervalRef.current);
      audioLevelIntervalRef.current = null;
    }

    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.srcObject = null;
      audioElementRef.current.remove();
      audioElementRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setIsConnecting(false);
    setIsMuted(false);
    setAudioLevel(0);
  }, []);

  const startCall = async () => {
    if (!config?.enabled) {
      toast({
        title: "Demo Unavailable",
        description: "Demo calls are currently disabled. Please try again later.",
        variant: "destructive",
      });
      return;
    }

    setIsConnecting(true);
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const sessionResponse = await fetch('/api/public/demo-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: selectedLanguage,
          voice: 'alloy',
        }),
      });

      if (!sessionResponse.ok) {
        const error = await sessionResponse.json();
        throw new Error(error.error || 'Failed to create session');
      }

      const demoSession = await sessionResponse.json();
      demoSessionRef.current = { id: demoSession.sessionId, token: demoSession.sessionToken };
      setTimeRemaining(demoSession.maxDuration);

      const tokenResponse = await fetch('/api/public/demo-ephemeral-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: demoSession.sessionId,
          sessionToken: demoSession.sessionToken,
        }),
      });

      if (!tokenResponse.ok) {
        const error = await tokenResponse.json();
        throw new Error(error.error || 'Failed to initialize AI session');
      }

      const tokenData = await tokenResponse.json();
      const ephemeralKey = tokenData.client_secret?.value;

      if (!ephemeralKey) {
        throw new Error('Invalid token response from server');
      }

      const pc = new RTCPeerConnection();
      peerConnectionRef.current = pc;

      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioElementRef.current = audioEl;

      pc.ontrack = (event) => {
        audioEl.srcObject = event.streams[0];
        audioEl.play().catch(e => console.log('Audio autoplay blocked:', e));
        setupRemoteAudioAnalyser(event.streams[0]);
      };
      
      document.body.appendChild(audioEl);

      if (mediaStreamRef.current) {
        const audioTrack = mediaStreamRef.current.getAudioTracks()[0];
        if (audioTrack) {
          pc.addTrack(audioTrack, mediaStreamRef.current);
        }
      }

      const dc = pc.createDataChannel('oai-events');
      dataChannelRef.current = dc;

      dc.onopen = () => {
        console.log('Data channel open');
      };

      dc.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'conversation.item.created' && data.item?.content) {
            const textContent = data.item.content.find((c: any) => c.type === 'text');
            if (textContent?.text) {
              transcriptRef.current.push(`[${data.item.role}]: ${textContent.text}`);
            }
          }
        } catch (e) {
          console.log('Failed to parse data channel message');
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await new Promise<void>((resolve) => {
        const checkState = () => {
          if (pc.iceGatheringState === 'complete') {
            resolve();
          }
        };
        if (pc.iceGatheringState === 'complete') {
          resolve();
        } else {
          pc.onicegatheringstatechange = checkState;
          setTimeout(resolve, 3000);
        }
      });

      const localDescription = pc.localDescription;
      if (!localDescription?.sdp) {
        throw new Error('Failed to create offer');
      }

      const sdpResponse = await fetch(`https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ephemeralKey}`,
          'Content-Type': 'application/sdp',
        },
        body: localDescription.sdp,
      });

      if (!sdpResponse.ok) {
        throw new Error('Failed to connect to OpenAI Realtime API');
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp,
      });

      setIsCallActive(true);
      setIsConnecting(false);

      timerRef.current = setInterval(() => {
        setTimeRemaining(prev => {
          if (prev <= 1) {
            endCall();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

    } catch (error: any) {
      console.error('Error starting demo call:', error);
      cleanup();
      toast({
        title: "Connection Failed",
        description: error.message || "Could not connect to AI agent. Please try again.",
        variant: "destructive",
      });
    }
  };

  startCallRef.current = startCall;

  useImperativeHandle(ref, () => ({
    startCall,
  }));

  useEffect(() => {
    const handleTriggerDemoCall = () => {
      if (config?.enabled && !isConnecting && !isCallActive && startCallRef.current) {
        startCallRef.current();
      }
    };
    window.addEventListener('trigger-demo-call', handleTriggerDemoCall);
    return () => window.removeEventListener('trigger-demo-call', handleTriggerDemoCall);
  }, [config?.enabled, isConnecting, isCallActive]);

  const endCall = useCallback(async () => {
    const transcript = transcriptRef.current.join('\n');
    const duration = (config?.maxDuration || 60) - timeRemaining;
    
    cleanup();
    transcriptRef.current = [];

    if (demoSessionRef.current) {
      try {
        await fetch(`/api/public/demo-session/${demoSessionRef.current.id}/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionToken: demoSessionRef.current.token,
            duration,
            transcript: transcript || null,
          }),
        });
      } catch (e) {
        console.error('Error ending demo session:', e);
      }
    }

    setIsCallActive(false);
    setAudioLevel(0);
    setTimeRemaining(config?.maxDuration || 60);
    toast({
      title: "Call Ended",
      description: "Thanks for trying our demo!",
    });
  }, [config?.maxDuration, timeRemaining, cleanup, toast]);

  const toggleMute = useCallback(() => {
    if (mediaStreamRef.current) {
      const audioTrack = mediaStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = isMuted;
        setIsMuted(!isMuted);
      }
    }
  }, [isMuted]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const isEnabled = config?.enabled ?? false;
  const appName = branding?.app_name || config?.appName || 'AgentLabs';
  const faviconUrl = branding?.favicon_url || branding?.logo_url;
  const selectedLangData = config?.languages?.find(l => l.code === selectedLanguage);
  const isDisabled = configLoading || !isEnabled;

  return (
    <div className={`fixed bottom-6 right-6 z-50 ${className || ''}`}>
      <AnimatePresence mode="wait">
        {isCallActive ? (
          <motion.div
            key="active-call"
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="flex flex-col items-center gap-3"
          >
            <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl px-5 py-4 flex items-center gap-4 border border-zinc-200 dark:border-zinc-700">
              <motion.div
                className="w-12 h-12 rounded-full flex items-center justify-center relative overflow-hidden bg-gradient-to-br from-primary/20 to-primary/5"
                animate={{ 
                  scale: 1 + audioLevel * 0.15,
                }}
                transition={{ duration: 0.1 }}
              >
                {faviconUrl ? (
                  <img src={faviconUrl} alt="" className="w-8 h-8 object-contain" />
                ) : (
                  <Volume2 className="h-5 w-5 text-primary" />
                )}
              </motion.div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 bg-zinc-100 dark:bg-zinc-800 rounded-full px-3 py-1.5">
                  <Timer className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="text-sm font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                    {formatTime(timeRemaining)}
                  </span>
                </div>

                <Button
                  variant={isMuted ? "destructive" : "outline"}
                  size="icon"
                  className="h-9 w-9 rounded-full"
                  onClick={toggleMute}
                  data-testid="button-mute"
                >
                  {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </Button>

                <Button
                  variant="destructive"
                  size="icon"
                  className="h-9 w-9 rounded-full"
                  onClick={endCall}
                  data-testid="button-end-call"
                >
                  <PhoneOff className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Powered by <span className="font-medium text-zinc-700 dark:text-zinc-300">{appName}</span>
            </span>
          </motion.div>
        ) : isConnecting ? (
          <motion.div
            key="connecting"
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="flex flex-col items-center gap-3"
          >
            <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl px-5 py-4 flex items-center gap-4 border border-zinc-200 dark:border-zinc-700">
              <motion.div
                className="w-12 h-12 rounded-full flex items-center justify-center relative overflow-hidden bg-gradient-to-br from-primary/20 to-primary/5"
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              >
                {faviconUrl ? (
                  <img src={faviconUrl} alt="" className="w-8 h-8 object-contain" />
                ) : (
                  <Loader2 className="h-5 w-5 text-primary animate-spin" />
                )}
              </motion.div>
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Connecting...
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={() => {
                  cleanup();
                  setIsConnecting(false);
                }}
                data-testid="button-cancel-connecting"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Powered by <span className="font-medium text-zinc-700 dark:text-zinc-300">{appName}</span>
            </span>
          </motion.div>
        ) : (
          <motion.div
            key="idle"
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="flex flex-col items-center gap-3"
          >
            <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl pl-3 pr-2 py-2.5 flex items-center gap-2 border border-zinc-200 dark:border-zinc-700">
              <div className="w-10 h-10 rounded-full flex items-center justify-center relative overflow-hidden bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20">
                {faviconUrl ? (
                  <img src={faviconUrl} alt="" className="w-6 h-6 object-contain" />
                ) : (
                  <Globe className="h-5 w-5 text-primary" />
                )}
              </div>

              <Button
                onClick={startCall}
                disabled={isDisabled}
                className="bg-zinc-900 dark:bg-white hover:bg-zinc-800 dark:hover:bg-zinc-100 text-white dark:text-zinc-900 rounded-full px-4 py-2 h-auto font-medium text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="button-voice-chat"
              >
                <Phone className="h-4 w-4" />
                {configLoading ? 'Loading...' : 'VOICE CHAT'}
              </Button>

              <div className="relative" ref={languageDropdownRef}>
                <button
                  onClick={() => setIsLanguageOpen(!isLanguageOpen)}
                  className="flex items-center gap-1.5 px-2.5 py-2 rounded-full border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                  data-testid="button-language-selector"
                >
                  <span className="text-lg leading-none" role="img" aria-label={selectedLangData?.name || 'English'}>
                    {LANGUAGE_FLAGS[selectedLanguage] || '🌐'}
                  </span>
                  <ChevronDown className={`h-3 w-3 text-zinc-500 transition-transform ${isLanguageOpen ? 'rotate-180' : ''}`} />
                </button>

                <AnimatePresence>
                  {isLanguageOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.95 }}
                      transition={{ duration: 0.15 }}
                      className="absolute bottom-full right-0 mb-2 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden min-w-[200px] max-h-[320px] overflow-y-auto"
                    >
                      {config?.languages?.map((lang) => (
                        <button
                          key={lang.code}
                          onClick={() => {
                            setSelectedLanguage(lang.code);
                            setIsLanguageOpen(false);
                          }}
                          className={`w-full flex items-center gap-3 px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-left ${
                            selectedLanguage === lang.code ? 'bg-zinc-100 dark:bg-zinc-800' : ''
                          }`}
                          data-testid={`language-option-${lang.code}`}
                        >
                          <span className="text-lg leading-none" role="img" aria-label={lang.name}>
                            {LANGUAGE_FLAGS[lang.code] || '🌐'}
                          </span>
                          <span className="text-sm text-zinc-700 dark:text-zinc-300">
                            {lang.nativeName}
                          </span>
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Powered by <span className="font-medium text-zinc-700 dark:text-zinc-300">{appName}</span>
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

DemoCallWidget.displayName = 'DemoCallWidget';
