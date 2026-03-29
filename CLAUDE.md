# ClearPrice - Healthcare Pricing Transparency

## What This Is
A consumer tool that answers: **"What will this procedure actually cost ME, at which facility, with MY insurance?"**

Shows in-network negotiated rate vs. out-of-network allowed amount vs. hospital cash price **side by side** — a comparison nobody else makes because the network system profits from opacity.

## The Thermodynamic Principle
Terabyte JSON files of insurer pricing data = high-energy chaotic state. We anneal it into one clear, personalized answer. Same philosophy as ClearFlow.

## Domain Expert
Johnny5 (Dad) ran a health insurance agency for 15 years with ~1,000 insureds. He understands benefit structures from the inside — deductibles, copays, coinsurance, OOP maximums, narrow networks, provider steering, pharma revenue-sharing.

## MVP Scope
- **Geography:** Wisconsin only
- **Insurers:** UnitedHealthcare, Anthem/Elevance, Medica (top 3 in WI)
- **User inputs:** Insurer, plan type, procedure/service needed, location
- **Output:** Every facility in area with negotiated rate, OON allowed amount, hospital cash price — personalized to user's deductible/coinsurance status

## Tech Stack
- **Frontend:** React (Vite)
- **Backend:** Supabase (PostgreSQL)
- **Intelligence:** Claude API (parsing, normalizing, explaining costs in plain English)
- **Data pipeline:** Python streaming parser (ijson) for insurer MRF files
- **Hosting:** Vercel (frontend) + Supabase (backend)

## Data Sources (all legally mandated, free, public)
1. **Insurer Machine-Readable Files** — Transparency in Coverage Rule (schema v2.0 as of Feb 2026)
   - In-network negotiated rates (JSON, monthly updates)
   - Out-of-network allowed amounts (JSON)
   - Table of Contents files point to all plan-specific files
2. **Hospital Price Transparency Files** — required since Jan 2021
   - Gross charge, discounted cash price, payer-specific negotiated charges
   - No standard format (each hospital publishes differently) — parsing challenge
3. **CMS schema:** https://github.com/CMSgov/price-transparency-guide

## Key Technical Challenges
- Individual in-network rate files can be 100GB-1TB — streaming parse only (ijson)
- No central index of insurer file URLs — manual discovery required
- Hospital files have no standard format — custom parsers per hospital
- Must flatten deeply nested JSON into relational tables for querying
- Monthly update cycle — pipeline needs incremental refresh

## Architecture Layers
1. **Data Pipeline** — Stream, filter, flatten insurer + hospital MRFs into Supabase
2. **Query Engine** — User inputs -> personalized cost lookup across all facilities
3. **Intelligence Layer** — Claude API explains costs in plain English, flags savings opportunities
4. **Frontend** — Clean, simple UI for consumers

## The ACE Angle
Looks like a helpful consumer app. IS a helpful consumer app. But every user who chooses the $400 MRI over the $2,800 one is a quiet act of revolution. Trojan horse for transparency.

## Future Layers
- Layer 2: Show gap between list price and what insurance actually pays
- Layer 3: Referral patterns, prescribing patterns, revenue relationships
