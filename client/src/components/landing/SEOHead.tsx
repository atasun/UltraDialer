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
import { useEffect } from "react";

interface OfferSchema {
  "@type": "Offer";
  price: string;
  priceCurrency: string;
  name?: string;
  description?: string;
}

interface SoftwareApplicationSchema {
  "@context": "https://schema.org";
  "@type": "SoftwareApplication";
  name: string;
  applicationCategory: string;
  operatingSystem?: string;
  description?: string;
  url?: string;
  offers?: OfferSchema | OfferSchema[];
  aggregateRating?: {
    "@type": "AggregateRating";
    ratingValue: string;
    ratingCount: string;
  };
  author?: {
    "@type": "Organization";
    name: string;
    url?: string;
  };
  screenshot?: string;
  featureList?: string[];
}

interface OrganizationSchema {
  name?: string;
  url?: string;
  logo?: string;
  description?: string;
  contactPoint?: {
    telephone?: string;
    contactType?: string;
    email?: string;
  };
  sameAs?: string[];
}

interface FaqItem {
  question: string;
  answer: string;
}

interface ProductSchema {
  name?: string;
  description?: string;
  image?: string;
  brand?: string;
  sku?: string;
  price?: string;
  priceCurrency?: string;
  availability?: 'InStock' | 'OutOfStock' | 'PreOrder' | 'Discontinued';
  url?: string;
  ratingValue?: string;
  ratingCount?: string;
}

interface SEOHeadProps {
  title: string;
  description: string;
  canonicalUrl?: string;
  ogImage?: string;
  keywords?: string[];
  structuredData?: Partial<SoftwareApplicationSchema>;
  twitterCard?: "summary" | "summary_large_image" | "app" | "player";
  twitterSite?: string;
  twitterCreator?: string;
  ogType?: string;
  ogSiteName?: string;
  noIndex?: boolean;
  noFollow?: boolean;
  additionalMetaTags?: Array<{
    name?: string;
    property?: string;
    content: string;
  }>;
  // New SEO module fields
  googleVerification?: string;
  bingVerification?: string;
  facebookAppId?: string;
  structuredDataOrg?: OrganizationSchema | null;
  structuredDataFaq?: FaqItem[] | null;
  structuredDataProduct?: ProductSchema | null;
}

const DEFAULT_OG_IMAGE = "/og-image.png";
const DEFAULT_TWITTER_CARD = "summary_large_image";

function getDefaultStructuredData(siteName: string): SoftwareApplicationSchema {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: siteName,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description: "AI-powered voice agents for automated calling, lead qualification, and 24/7 customer support.",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      name: "Free Tier",
      description: "Get started with AI voice agents for free"
    },
    author: {
      "@type": "Organization",
      name: siteName
    }
  };
}

function createOrUpdateMetaTag(
  attributeType: "name" | "property",
  attributeValue: string,
  content: string
): void {
  let element = document.querySelector(`meta[${attributeType}="${attributeValue}"]`);
  
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attributeType, attributeValue);
    document.head.appendChild(element);
  }
  
  element.setAttribute("content", content);
}

function createOrUpdateLinkTag(rel: string, href: string): void {
  let element = document.querySelector(`link[rel="${rel}"]`);
  
  if (!element) {
    element = document.createElement("link");
    element.setAttribute("rel", rel);
    document.head.appendChild(element);
  }
  
  element.setAttribute("href", href);
}

function removeMetaTag(attributeType: "name" | "property", attributeValue: string): void {
  const element = document.querySelector(`meta[${attributeType}="${attributeValue}"]`);
  if (element) {
    element.remove();
  }
}

function removeLinkTag(rel: string): void {
  const element = document.querySelector(`link[rel="${rel}"]`);
  if (element) {
    element.remove();
  }
}

function getOrCreateJsonLdScript(): HTMLScriptElement {
  let script = document.querySelector('script[type="application/ld+json"][data-seo-head]') as HTMLScriptElement | null;
  
  if (!script) {
    script = document.createElement("script");
    script.type = "application/ld+json";
    script.setAttribute("data-seo-head", "true");
    document.head.appendChild(script);
  }
  
  return script;
}

function removeJsonLdScript(): void {
  const script = document.querySelector('script[type="application/ld+json"][data-seo-head]');
  if (script) {
    script.remove();
  }
}

// Helper to create additional JSON-LD scripts for Organization, FAQ, Product schemas
function getOrCreateJsonLdScriptById(id: string): HTMLScriptElement {
  let script = document.querySelector(`script[type="application/ld+json"][data-seo-id="${id}"]`) as HTMLScriptElement | null;
  
  if (!script) {
    script = document.createElement("script");
    script.type = "application/ld+json";
    script.setAttribute("data-seo-id", id);
    document.head.appendChild(script);
  }
  
  return script;
}

function removeJsonLdScriptById(id: string): void {
  const script = document.querySelector(`script[type="application/ld+json"][data-seo-id="${id}"]`);
  if (script) {
    script.remove();
  }
}

export function SEOHead({
  title,
  description,
  canonicalUrl,
  ogImage = DEFAULT_OG_IMAGE,
  keywords = [],
  structuredData,
  twitterCard = DEFAULT_TWITTER_CARD,
  twitterSite,
  twitterCreator,
  ogType = "website",
  ogSiteName = "AgentLabs",
  noIndex = false,
  noFollow = false,
  additionalMetaTags = [],
  googleVerification,
  bingVerification,
  facebookAppId,
  structuredDataOrg,
  structuredDataFaq,
  structuredDataProduct
}: SEOHeadProps): null {
  useEffect(() => {
    const previousTitle = document.title;
    
    const formattedTitle = title.includes(ogSiteName) 
      ? title 
      : `${title} | ${ogSiteName}`;
    
    document.title = formattedTitle;

    createOrUpdateMetaTag("name", "description", description);
    
    if (keywords.length > 0) {
      createOrUpdateMetaTag("name", "keywords", keywords.join(", "));
    }

    const robotsContent = [
      noIndex ? "noindex" : "index",
      noFollow ? "nofollow" : "follow"
    ].join(", ");
    createOrUpdateMetaTag("name", "robots", robotsContent);

    // Google and Bing verification meta tags
    if (googleVerification) {
      createOrUpdateMetaTag("name", "google-site-verification", googleVerification);
    }
    if (bingVerification) {
      createOrUpdateMetaTag("name", "msvalidate.01", bingVerification);
    }

    // Facebook App ID
    if (facebookAppId) {
      createOrUpdateMetaTag("property", "fb:app_id", facebookAppId);
    }

    createOrUpdateMetaTag("property", "og:title", formattedTitle);
    createOrUpdateMetaTag("property", "og:description", description);
    createOrUpdateMetaTag("property", "og:type", ogType);
    createOrUpdateMetaTag("property", "og:site_name", ogSiteName);
    
    if (ogImage) {
      const absoluteOgImage = ogImage.startsWith("http") 
        ? ogImage 
        : `${window.location.origin}${ogImage}`;
      createOrUpdateMetaTag("property", "og:image", absoluteOgImage);
      createOrUpdateMetaTag("property", "og:image:alt", title);
    }
    
    if (canonicalUrl) {
      createOrUpdateMetaTag("property", "og:url", canonicalUrl);
      createOrUpdateLinkTag("canonical", canonicalUrl);
    }

    createOrUpdateMetaTag("name", "twitter:card", twitterCard);
    createOrUpdateMetaTag("name", "twitter:title", formattedTitle);
    createOrUpdateMetaTag("name", "twitter:description", description);
    
    if (ogImage) {
      const absoluteOgImage = ogImage.startsWith("http") 
        ? ogImage 
        : `${window.location.origin}${ogImage}`;
      createOrUpdateMetaTag("name", "twitter:image", absoluteOgImage);
      createOrUpdateMetaTag("name", "twitter:image:alt", title);
    }
    
    if (twitterSite) {
      createOrUpdateMetaTag("name", "twitter:site", twitterSite);
    }
    
    if (twitterCreator) {
      createOrUpdateMetaTag("name", "twitter:creator", twitterCreator);
    }

    additionalMetaTags.forEach(tag => {
      if (tag.name) {
        createOrUpdateMetaTag("name", tag.name, tag.content);
      } else if (tag.property) {
        createOrUpdateMetaTag("property", tag.property, tag.content);
      }
    });

    // Default SoftwareApplication structured data
    const defaultData = getDefaultStructuredData(ogSiteName);
    const mergedStructuredData: SoftwareApplicationSchema = {
      ...defaultData,
      ...structuredData,
      url: canonicalUrl || structuredData?.url || window.location.origin,
      description: structuredData?.description || description
    };

    const jsonLdScript = getOrCreateJsonLdScript();
    jsonLdScript.textContent = JSON.stringify(mergedStructuredData, null, 2);

    // Organization structured data from SEO settings
    if (structuredDataOrg && Object.keys(structuredDataOrg).length > 0) {
      const orgSchema = {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: structuredDataOrg.name || ogSiteName,
        url: structuredDataOrg.url || window.location.origin,
        ...(structuredDataOrg.logo && { logo: structuredDataOrg.logo }),
        ...(structuredDataOrg.description && { description: structuredDataOrg.description }),
        ...(structuredDataOrg.contactPoint && {
          contactPoint: {
            "@type": "ContactPoint",
            ...structuredDataOrg.contactPoint
          }
        }),
        ...(structuredDataOrg.sameAs && structuredDataOrg.sameAs.length > 0 && { 
          sameAs: structuredDataOrg.sameAs 
        })
      };
      const orgScript = getOrCreateJsonLdScriptById("org");
      orgScript.textContent = JSON.stringify(orgSchema, null, 2);
    }

    // FAQ structured data from SEO settings
    if (structuredDataFaq && structuredDataFaq.length > 0) {
      const faqSchema = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: structuredDataFaq.map(item => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: item.answer
          }
        }))
      };
      const faqScript = getOrCreateJsonLdScriptById("faq");
      faqScript.textContent = JSON.stringify(faqSchema, null, 2);
    }

    // Product structured data from SEO settings
    if (structuredDataProduct && structuredDataProduct.name) {
      // Map availability to schema.org URL format
      const availabilityMap: Record<string, string> = {
        'InStock': 'https://schema.org/InStock',
        'OutOfStock': 'https://schema.org/OutOfStock',
        'PreOrder': 'https://schema.org/PreOrder',
        'Discontinued': 'https://schema.org/Discontinued'
      };
      
      const productSchema: Record<string, any> = {
        "@context": "https://schema.org",
        "@type": "Product",
        name: structuredDataProduct.name
      };
      
      if (structuredDataProduct.description) {
        productSchema.description = structuredDataProduct.description;
      }
      if (structuredDataProduct.image) {
        productSchema.image = structuredDataProduct.image;
      }
      if (structuredDataProduct.sku) {
        productSchema.sku = structuredDataProduct.sku;
      }
      if (structuredDataProduct.url) {
        productSchema.url = structuredDataProduct.url;
      }
      if (structuredDataProduct.brand) {
        productSchema.brand = {
          "@type": "Brand",
          name: structuredDataProduct.brand
        };
      }
      
      // Add offers with price and availability
      if (structuredDataProduct.price || structuredDataProduct.availability) {
        const offers: Record<string, any> = {
          "@type": "Offer"
        };
        if (structuredDataProduct.price) {
          offers.price = structuredDataProduct.price;
        }
        if (structuredDataProduct.priceCurrency) {
          offers.priceCurrency = structuredDataProduct.priceCurrency;
        }
        if (structuredDataProduct.availability && availabilityMap[structuredDataProduct.availability]) {
          offers.availability = availabilityMap[structuredDataProduct.availability];
        }
        if (structuredDataProduct.url) {
          offers.url = structuredDataProduct.url;
        }
        productSchema.offers = offers;
      }
      
      // Add aggregate rating if provided
      if (structuredDataProduct.ratingValue && structuredDataProduct.ratingCount) {
        productSchema.aggregateRating = {
          "@type": "AggregateRating",
          ratingValue: structuredDataProduct.ratingValue,
          reviewCount: structuredDataProduct.ratingCount
        };
      }
      
      const productScript = getOrCreateJsonLdScriptById("product");
      productScript.textContent = JSON.stringify(productSchema, null, 2);
    }

    return () => {
      document.title = previousTitle;
      
      removeMetaTag("name", "description");
      removeMetaTag("name", "keywords");
      removeMetaTag("name", "robots");
      removeMetaTag("name", "google-site-verification");
      removeMetaTag("name", "msvalidate.01");
      removeMetaTag("property", "fb:app_id");
      
      removeMetaTag("property", "og:title");
      removeMetaTag("property", "og:description");
      removeMetaTag("property", "og:type");
      removeMetaTag("property", "og:site_name");
      removeMetaTag("property", "og:image");
      removeMetaTag("property", "og:image:alt");
      removeMetaTag("property", "og:url");
      
      removeMetaTag("name", "twitter:card");
      removeMetaTag("name", "twitter:title");
      removeMetaTag("name", "twitter:description");
      removeMetaTag("name", "twitter:image");
      removeMetaTag("name", "twitter:image:alt");
      removeMetaTag("name", "twitter:site");
      removeMetaTag("name", "twitter:creator");
      
      removeLinkTag("canonical");
      
      additionalMetaTags.forEach(tag => {
        if (tag.name) {
          removeMetaTag("name", tag.name);
        } else if (tag.property) {
          removeMetaTag("property", tag.property);
        }
      });
      
      removeJsonLdScript();
      removeJsonLdScriptById("org");
      removeJsonLdScriptById("faq");
      removeJsonLdScriptById("product");
    };
  }, [
    title,
    description,
    canonicalUrl,
    ogImage,
    keywords,
    structuredData,
    twitterCard,
    twitterSite,
    twitterCreator,
    ogType,
    ogSiteName,
    noIndex,
    noFollow,
    additionalMetaTags,
    googleVerification,
    bingVerification,
    facebookAppId,
    structuredDataOrg,
    structuredDataFaq,
    structuredDataProduct
  ]);

  return null;
}

export type { SEOHeadProps, SoftwareApplicationSchema, OfferSchema };
