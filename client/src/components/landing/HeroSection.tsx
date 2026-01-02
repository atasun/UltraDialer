/**
 * ============================================================
 * HeroSection - awaz.ai Exact Design Match
 * Features: Dark solid background, phone mockups, sound wave icon,
 * coral badge, green CTA button, company logos strip
 * ============================================================
 */
import { motion, useReducedMotion, useInView, AnimatePresence } from "framer-motion";
import { Check, ChevronDown, Phone, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRef, useState, useEffect } from "react";
import { Link } from "wouter";
import { AuthStorage } from "@/lib/auth-storage";
import { useTranslation } from 'react-i18next';
import { useQuery } from "@tanstack/react-query";

// Typing effect component
const TypingWord = ({ words }: { words: string[] }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [displayText, setDisplayText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const currentWord = words[currentIndex];
    const typingSpeed = isDeleting ? 50 : 100;
    const pauseDuration = 2000;

    if (!isDeleting && displayText === currentWord) {
      const timeout = setTimeout(() => setIsDeleting(true), pauseDuration);
      return () => clearTimeout(timeout);
    }

    if (isDeleting && displayText === "") {
      setIsDeleting(false);
      setCurrentIndex((prev) => (prev + 1) % words.length);
      return;
    }

    const timeout = setTimeout(() => {
      if (isDeleting) {
        setDisplayText(currentWord.slice(0, displayText.length - 1));
      } else {
        setDisplayText(currentWord.slice(0, displayText.length + 1));
      }
    }, typingSpeed);

    return () => clearTimeout(timeout);
  }, [displayText, isDeleting, currentIndex, words]);

  return (
    <span className="inline-block min-w-[200px] text-left">
      <span className="bg-gradient-to-r from-teal-300 to-teal-400 bg-clip-text text-transparent">
        {displayText}
      </span>
      <motion.span
        animate={{ opacity: [1, 0] }}
        transition={{ duration: 0.5, repeat: Infinity, repeatType: "reverse" }}
        className="inline-block w-[3px] h-[0.9em] bg-teal-400 ml-1 align-middle"
      />
    </span>
  );
};

// Sound wave animation component
const SoundWaveIcon = () => (
  <div className="flex items-center justify-center gap-[2px] h-8">
    {[...Array(12)].map((_, i) => (
      <motion.div
        key={i}
        className="w-[3px] bg-gradient-to-t from-teal-500 to-teal-300 rounded-full"
        animate={{
          height: [8, 20 + Math.random() * 12, 8],
        }}
        transition={{
          duration: 0.8 + Math.random() * 0.4,
          repeat: Infinity,
          ease: "easeInOut",
          delay: i * 0.05,
        }}
      />
    ))}
  </div>
);

// Stats badge matching awaz.ai style
const StatsBadge = ({ value, label }: { value: string; label: string }) => (
  <div 
    className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10"
    data-testid={`stats-badge-${label.toLowerCase()}`}
  >
    <span className="text-lg font-bold text-white">{value}</span>
    <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">{label}</span>
  </div>
);

// Trust badge with green checkmark
const TrustBadge = ({ text }: { text: string }) => (
  <div className="flex items-center gap-2 text-sm text-gray-400">
    <div className="w-5 h-5 rounded-full bg-teal-500/20 flex items-center justify-center">
      <Check className="h-3 w-3 text-teal-500" />
    </div>
    <span>{text}</span>
  </div>
);

// Phone mockup component
const PhoneMockup = ({ side }: { side: "left" | "right" }) => {
  const shouldReduceMotion = useReducedMotion();
  
  return (
    <motion.div
      className={`absolute top-1/2 -translate-y-1/2 hidden lg:block ${
        side === "left" ? "-left-16 xl:left-0" : "-right-16 xl:right-0"
      }`}
      initial={{ opacity: 0, x: side === "left" ? -50 : 50 }}
      animate={{ opacity: 0.6, x: 0 }}
      transition={{ duration: 1, delay: 0.5, ease: "easeOut" }}
    >
      <div className="relative w-48 xl:w-56 h-96 xl:h-[28rem]">
        {/* Phone frame */}
        <div className="absolute inset-0 bg-gradient-to-b from-gray-800 to-gray-900 rounded-[2.5rem] border border-gray-700 shadow-2xl">
          {/* Screen */}
          <div className="absolute inset-3 bg-gray-950 rounded-[2rem] overflow-hidden">
            {/* Status bar */}
            <div className="h-6 bg-gray-900 flex items-center justify-center">
              <div className="w-16 h-1 bg-gray-700 rounded-full" />
            </div>
            {/* Content */}
            <div className="p-4 space-y-3">
              <div className="w-full h-3 bg-gray-800 rounded" />
              <div className="w-3/4 h-3 bg-gray-800 rounded" />
              <div className="w-1/2 h-3 bg-gray-800 rounded" />
              <div className="mt-6 w-full h-20 bg-gradient-to-r from-indigo-900/50 to-purple-900/50 rounded-lg" />
            </div>
          </div>
        </div>
        {/* Side button */}
        <div className={`absolute top-24 ${side === "left" ? "-left-1" : "-right-1"} w-1 h-12 bg-gray-700 rounded-full`} />
      </div>
    </motion.div>
  );
};

// Company logos
const companyLogos = [
  { name: "RE MAX", className: "text-lg font-bold tracking-tight" },
  { name: "Claro", className: "text-xl font-semibold text-blue-400" },
  { name: "TOMORROWLAND", className: "text-sm font-light tracking-widest" },
  { name: "LIMITLESS", className: "text-base font-medium tracking-wide" },
  { name: "segware", className: "text-lg font-semibold" },
  { name: "wakefit", className: "text-lg font-medium italic" },
  { name: "AVENTIS", className: "text-base font-semibold tracking-wide" },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.2,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.6,
      ease: [0.25, 0.4, 0.25, 1],
    },
  },
};

export function HeroSection() {
  const { t } = useTranslation();
  const shouldReduceMotion = useReducedMotion();
  const isAuthenticated = AuthStorage.isAuthenticated();
  const isAdmin = AuthStorage.isAdmin();
  const sectionRef = useRef(null);
  const isInView = useInView(sectionRef, { once: true });

  const rotatingWords = [
    t('landing.hero.rotatingWords.sales'),
    t('landing.hero.rotatingWords.support'),
    t('landing.hero.rotatingWords.outreach'),
    t('landing.hero.rotatingWords.appointments'),
  ];

  const handleScrollDown = () => {
    window.scrollTo({
      top: window.innerHeight - 80,
      behavior: "smooth",
    });
  };

  const getDashboardLink = () => {
    if (isAuthenticated) {
      return isAdmin ? "/admin" : "/app";
    }
    return "/login";
  };

  return (
    <section
      ref={sectionRef}
      className="relative min-h-screen flex flex-col justify-center overflow-hidden bg-navy-900"
      data-testid="hero-section"
    >
      {/* Subtle gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-navy-800/50 to-navy-900" />
      
      {/* Vignette effect */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,#050B1A_70%)]" />
      
      {/* Subtle teal glow accent */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-teal-500/5 rounded-full blur-3xl" />

      {/* Phone mockups */}
      <PhoneMockup side="left" />
      <PhoneMockup side="right" />

      {/* Main content */}
      <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-24 pb-20 text-center">
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
          className="space-y-8"
        >
          {/* Sound wave icon */}
          <motion.div variants={itemVariants} className="flex justify-center">
            <SoundWaveIcon />
          </motion.div>

          {/* Badge - teal color */}
          <motion.div variants={itemVariants} className="flex justify-center">
            <span className="text-sm font-medium text-teal-400 tracking-wide">
              {t('landing.hero.badge')}
            </span>
          </motion.div>

          {/* Main headline */}
          <motion.h1
            variants={itemVariants}
            className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.1] text-white"
            data-testid="hero-headline"
          >
            {t('landing.hero.headline')}
            <br />
            <TypingWord words={rotatingWords} />
          </motion.h1>

          {/* Subheadline */}
          <motion.p
            variants={itemVariants}
            className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed"
            data-testid="hero-subheadline"
          >
            {t('landing.hero.subheadline', { humanLike: '' }).split('{{humanLike}}')[0]}
            <span className="font-semibold text-white">{t('landing.hero.humanLike')}</span>
            {t('landing.hero.subheadline', { humanLike: '' }).split('{{humanLike}}')[1] || ' AI voice agents to handle outbound and inbound calls, book meetings, and take actions 24/7.'}
          </motion.p>

          {/* Stats badges */}
          <motion.div 
            variants={itemVariants}
            className="flex flex-wrap justify-center gap-3 pt-2"
          >
            <StatsBadge value="5X" label={t('landing.hero.statsProductivity')} />
            <StatsBadge value="100X" label={t('landing.hero.statsScalability')} />
          </motion.div>

          {/* CTA Buttons */}
          <motion.div
            variants={itemVariants}
            className="flex flex-col sm:flex-row justify-center items-center gap-4 pt-4"
          >
            <Link href={getDashboardLink()}>
              <Button
                size="lg"
                className="h-14 px-10 text-base font-semibold bg-teal-500 hover:bg-teal-600 text-white border-0 rounded-full shadow-lg shadow-teal-500/25 transition-all duration-300 hover:shadow-teal-500/40 hover:scale-[1.02]"
                data-testid="button-hero-get-started"
              >
                {t('landing.hero.getStarted')}
              </Button>
            </Link>
            <Button
              size="lg"
              variant="outline"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('trigger-demo-call'));
              }}
              className="h-14 px-8 text-base font-semibold rounded-full border-2 border-white/20 text-white hover:bg-white/10 hover:border-white/30 transition-all duration-300"
              data-testid="button-hero-demo-call"
            >
              <Phone className="h-5 w-5 mr-2" />
              Try Demo Call
            </Button>
          </motion.div>

          {/* Trust badges */}
          <motion.div
            variants={itemVariants}
            className="flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-8 pt-2"
            data-testid="hero-trust-badges"
          >
            <TrustBadge text={t('landing.hero.freeTrial')} />
            <TrustBadge text={t('landing.hero.freeCredit')} />
          </motion.div>
        </motion.div>

        {/* Scroll indicator */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.5, duration: 0.6 }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2"
        >
          <button
            onClick={handleScrollDown}
            className="group focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 rounded-full p-2"
            aria-label="Scroll down"
            data-testid="button-scroll-indicator"
          >
            <ChevronDown className="h-6 w-6 text-gray-500 animate-bounce group-hover:text-white transition-colors" />
          </button>
        </motion.div>
      </div>

      {/* Company logos strip */}
      <div className="relative z-10 border-t border-teal-900/30 bg-navy-900/80 backdrop-blur-sm mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1, duration: 0.6 }}
            className="flex flex-wrap items-center justify-center gap-8 md:gap-12 lg:gap-16"
          >
            {companyLogos.map((logo, index) => (
              <div 
                key={logo.name}
                className={`text-gray-500 hover:text-gray-300 transition-colors cursor-default ${logo.className}`}
                data-testid={`logo-${logo.name.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {logo.name}
              </div>
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  );
}

export default HeroSection;
