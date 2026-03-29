# ClearPrice Architecture

## Data Landscape

### Insurer Machine-Readable Files (MRFs)

The Transparency in Coverage Rule requires every insurer to publish three file types:

#### 1. Table of Contents (TOC) — Entry Point
```json
{
  "reporting_entity_name": "UnitedHealthcare",
  "reporting_entity_type": "health insurance issuer",
  "reporting_structure": [
    {
      "reporting_plans": [
        {
          "plan_name": "UHC Choice Plus",
          "plan_id": "12345",
          "plan_id_type": "EIN",
          "plan_market_type": "group"
        }
      ],
      "in_network_files": [
        {
          "description": "In-network rates",
          "location": "https://..."
        }
      ],
      "allowed_amount_file": {
        "description": "Out-of-network allowed amounts",
        "location": "https://..."
      }
    }
  ]
}
```

#### 2. In-Network Rates — The Big One (100GB-1TB per file)
```json
{
  "in_network": [
    {
      "negotiation_arrangement": "ffs",
      "billing_code_type": "CPT",
      "billing_code": "70553",
      "description": "MRI brain w/o & w/dye",
      "negotiated_rates": [
        {
          "provider_references": [1, 2, 3],
          "negotiated_prices": [
            {
              "negotiated_type": "negotiated",
              "negotiated_rate": 425.00,
              "billing_class": "professional",
              "setting": "outpatient",
              "expiration_date": "2026-12-31"
            }
          ]
        }
      ]
    }
  ],
  "provider_references": [
    {
      "provider_group_id": 1,
      "provider_groups": [
        {
          "npi": ["1234567890"],
          "tin": { "type": "ein", "value": "12-3456789" }
        }
      ]
    }
  ]
}
```

#### 3. Allowed Amounts (Out-of-Network)
```json
{
  "out_of_network": [
    {
      "billing_code_type": "CPT",
      "billing_code": "70553",
      "description": "MRI brain w/o & w/dye",
      "allowed_amounts": [
        {
          "tin": { "type": "ein", "value": "12-3456789" },
          "billing_class": "professional",
          "payments": [
            {
              "allowed_amount": 350.00,
              "providers": [
                {
                  "billed_charge": 1200.00,
                  "npi": ["1234567890"]
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

### Hospital Price Transparency Files

No standard format. Each hospital publishes their own CSV/JSON with:
- Gross charge (sticker price)
- Discounted cash price
- Payer-specific negotiated charges
- De-identified min/max negotiated charges

### Wisconsin Target Insurers

| Insurer | WI Market Share | MRF Location |
|---------|----------------|--------------|
| UnitedHealthcare | ~22% | transparency-in-coverage.uhc.com |
| Anthem/Elevance | ~21% | S3 bucket (30GB TOC) |
| Medica | ~10% | TBD - need to locate |

## Pipeline Architecture

```
┌─────────────────────────────────────────────────┐
│                DATA PIPELINE (Python)            │
│                                                  │
│  1. Discover TOC URLs for target insurers        │
│  2. Stream TOC -> extract file URLs              │
│  3. Stream In-Network files with filters:        │
│     - WI providers only (NPI lookup)             │
│     - Common procedures (CPT code whitelist)     │
│  4. Stream Allowed-Amount files (same filters)   │
│  5. Parse hospital files per-hospital            │
│  6. Flatten & load into Supabase                 │
│                                                  │
│  Tools: Python + ijson + requests(stream=True)   │
│  Filter aggressively during stream — never       │
│  load full file into memory                      │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              SUPABASE (PostgreSQL)                │
│                                                  │
│  Tables:                                         │
│  ├── procedures        (CPT/HCPCS codes + names) │
│  ├── providers         (NPI, name, address, type)│
│  ├── facilities        (hospital/clinic details)  │
│  ├── in_network_rates  (insurer+plan+code+rate)  │
│  ├── oon_allowed       (insurer+code+allowed)    │
│  ├── hospital_prices   (facility+code+cash price)│
│  └── insurers          (name, plan types, TOC)   │
│                                                  │
│  Indexes: billing_code, npi, facility, insurer   │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              QUERY ENGINE (Supabase RPC)          │
│                                                  │
│  Input: procedure, location, insurer, plan,      │
│         deductible_met, coinsurance_rate          │
│                                                  │
│  Output per facility:                            │
│  ├── In-network negotiated rate                  │
│  ├── Your estimated cost (after deductible/coins)│
│  ├── OON allowed amount                          │
│  ├── Hospital cash/self-pay price                │
│  ├── Distance from user                          │
│  └── Savings vs highest-cost option              │
│                                                  │
│  Sort by: lowest cost to patient (default)       │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              INTELLIGENCE LAYER (Claude API)      │
│                                                  │
│  - Explain costs in plain English                │
│  - Flag when OON cash < in-network after coins   │
│  - Suggest questions to ask provider             │
│  - Translate billing codes to human language     │
│  - "Did you know?" education moments             │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              FRONTEND (React + Vite)              │
│                                                  │
│  1. Search: "I need an MRI of my brain"          │
│  2. Select: insurer, plan type                   │
│  3. Personalize: deductible status, coinsurance  │
│  4. Results: comparison table by facility        │
│     - In-network cost (YOUR cost)                │
│     - Cash price                                 │
│     - OON allowed amount                         │
│     - Savings highlighted                        │
│  5. Detail view: plain-English explanation        │
│                                                  │
│  Deploy: Vercel                                  │
└─────────────────────────────────────────────────┘
```

## MVP Build Order

### Phase 1: Data Pipeline (Python)
1. Locate TOC URLs for UHC + Anthem in Wisconsin
2. Build streaming parser that extracts WI-specific rates for a handful of common CPT codes
3. Flatten into CSV/Supabase tables
4. Validate against known prices (sanity check)

### Phase 2: Database Schema + Query Engine
1. Design Supabase tables
2. Load parsed data
3. Build RPC function: given (procedure, insurer, location) -> ranked facility list with prices

### Phase 3: Frontend
1. Simple search -> results flow
2. Personalization (deductible/coinsurance inputs)
3. Side-by-side comparison view
4. Claude API integration for plain-English explanations

### Phase 4: Hospital Cash Prices
1. Parse hospital transparency files for major WI hospitals
2. Add cash price column to comparison
3. Flag "cash price beats insurance" scenarios — THE KILLER FEATURE

## Key Insight to Surface
> Sometimes the out-of-network cash price at a better facility is LESS than the in-network cost after deductible/coinsurance. The network system isn't designed to save patients money — it's designed to capture revenue.

This comparison is what makes ClearPrice different from every other tool.
