# Hospital Cash Prices - Research Notes (Layer 2)

## When to Build This
After Layer 1 (insurer negotiated rate comparison) is solid. Cash prices matter most for:
- Patients who haven't met their deductible and are unlikely to
- High-deductible plans
- Uninsured/underinsured
- Exposing when insurer negotiated rate > cash price (the real story)

## Best Approach: TPAFS + cms-hpt.txt

1. **TPAFS GitHub** has a CSV of known hospital MRF URLs:
   `https://github.com/TPAFS/transparency-data/blob/main/price_transparency/hospitals/machine_readable_links.csv`
   - Filter to Wisconsin, get direct file URLs
   - Companion file has all ~6,120 US hospitals

2. **cms-hpt.txt** — Every hospital must publish this at their website root:
   - `https://hospital.com/cms-hpt.txt`
   - Contains URLs to their machine-readable pricing files
   - ~61% compliance rate

3. **DoltHub** has pre-parsed data (free):
   - `dolt clone dolthub/transparency-in-pricing`
   - Query: `SELECT * FROM hospitals WHERE state = 'WI'`
   - ~1,000 hospitals nationally, WI coverage TBD

## Major WI Health Systems
- Advocate Aurora: aurorahealthcare.org/patients-visitors/billing-payment/health-care-costs
- Ascension WI: healthcare.ascension.org/price-transparency/price-transparency-files
- UW Health: uwhealth.org/billing-insurance/cms-price-transparency
- Froedtert/MCW: froedtert.com/price-transparency
- Marshfield: marshfieldclinic.org/patient-resources
- Gundersen/Emplify: gundersenhealth.org/cost-estimates/charges
- ProHealth: found by Dad — Mukwonago, Oconomowoc, Waukesha files

## File Format
CMS mandates 3 formats: CSV tall, CSV wide, JSON
Key field: `discounted_cash_price`
Schema at: github.com/CMSgov/hospital-price-transparency
