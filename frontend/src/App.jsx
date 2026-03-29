import { useState } from 'react'
import { supabase, DEMO_MODE } from './supabase'
import './App.css'

const PROCEDURES = [
  { code: '70553', name: 'MRI Brain (with & without contrast)', category: 'imaging' },
  { code: '70551', name: 'MRI Brain (without contrast)', category: 'imaging' },
  { code: '73721', name: 'MRI Lower Joint (knee, ankle, etc.)', category: 'imaging' },
  { code: '74177', name: 'CT Abdomen & Pelvis', category: 'imaging' },
  { code: '71260', name: 'CT Chest', category: 'imaging' },
  { code: '77067', name: 'Screening Mammogram', category: 'imaging' },
  { code: '80053', name: 'Comprehensive Metabolic Panel', category: 'lab' },
  { code: '85025', name: 'CBC (Complete Blood Count)', category: 'lab' },
  { code: '81001', name: 'Urinalysis', category: 'lab' },
  { code: '99213', name: 'Office Visit (Established, Level 3)', category: 'office_visit' },
  { code: '99214', name: 'Office Visit (Established, Level 4)', category: 'office_visit' },
  { code: '99203', name: 'Office Visit (New, Level 3)', category: 'office_visit' },
  { code: '27447', name: 'Total Knee Replacement', category: 'surgery' },
  { code: '29881', name: 'Knee Arthroscopy', category: 'surgery' },
  { code: '43239', name: 'Upper GI Endoscopy with Biopsy', category: 'surgery' },
  { code: '45380', name: 'Colonoscopy with Biopsy', category: 'surgery' },
  { code: '59400', name: 'Vaginal Delivery (Routine OB)', category: 'maternity' },
  { code: '59510', name: 'C-Section (Routine OB)', category: 'maternity' },
]

const CATEGORIES = {
  imaging: 'Imaging',
  lab: 'Lab Work',
  office_visit: 'Office Visits',
  surgery: 'Surgery',
  maternity: 'Maternity',
}

// Keywords that indicate a provider's specialty is relevant to a procedure category
const RELEVANT_SPECIALTIES = {
  surgery: ['orthop', 'surg', 'hospital', 'medical center', 'acute care'],
  imaging: ['radiol', 'imaging', 'diagnost', 'hospital', 'medical center', 'acute care', 'mri', 'clinic'],
  lab: ['pathol', 'lab', 'clinical', 'hospital', 'medical center', 'acute care', 'clinic'],
  office_visit: [], // All providers can have office visits
  maternity: ['obstet', 'gynecol', 'ob/', 'midwif', 'nurse pract', 'hospital', 'medical center', 'family', 'acute care'],
}

function isRelevantSpecialty(taxonomy, category) {
  if (!taxonomy || !category) return true // If we don't know, don't flag
  const keywords = RELEVANT_SPECIALTIES[category]
  if (!keywords || keywords.length === 0) return true // No filter for this category
  const lower = taxonomy.toLowerCase()
  return keywords.some(k => lower.includes(k))
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

/**
 * Calculate what the patient actually pays based on their benefit structure.
 *
 * deductibleRemaining: how much of the annual deductible they haven't met yet
 * coinsuranceRate: patient's share after deductible (e.g., 0.20 for 80/20 plan)
 * oopMaxRemaining: how much they have left before hitting out-of-pocket max
 */
function calculateYourCost(negotiatedRate, { deductibleRemaining = 0, coinsuranceRate = 0, oopMaxRemaining = Infinity }) {
  if (deductibleRemaining <= 0 && coinsuranceRate <= 0) return 0

  let patientOwes = 0
  let remaining = negotiatedRate

  // First: patient pays toward deductible
  if (deductibleRemaining > 0) {
    const deductiblePortion = Math.min(remaining, deductibleRemaining)
    patientOwes += deductiblePortion
    remaining -= deductiblePortion
  }

  // Then: patient pays coinsurance on the rest
  if (remaining > 0 && coinsuranceRate > 0) {
    patientOwes += remaining * coinsuranceRate
  }

  // Cap at OOP max remaining
  if (oopMaxRemaining < Infinity) {
    patientOwes = Math.min(patientOwes, oopMaxRemaining)
  }

  return Math.round(patientOwes * 100) / 100
}

function PriceBar({ rate, minRate, maxRate, isLowest, isHighest }) {
  const range = maxRate - minRate || 1
  const width = Math.max(5, ((rate - minRate) / range) * 100)
  return (
    <div className="price-bar-container">
      <div
        className={`price-bar ${isLowest ? 'lowest' : ''} ${isHighest ? 'highest' : ''}`}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}

/**
 * Group results by facility using TIN matching, then by city as fallback.
 * Returns array of { facility, facilityRate, professionals: [{ ...result, totalEstimate }] }
 */
function groupByFacility(results) {
  const facilities = results.filter(r => r.billing_class === 'institutional')
  const professionals = results.filter(r => r.billing_class === 'professional')

  if (facilities.length === 0 || professionals.length === 0) return null

  // Build TIN -> facility mapping
  const tinFacility = new Map()
  const cityFacility = new Map()
  for (const f of facilities) {
    if (f.provider_tin) tinFacility.set(f.provider_tin, f)
    const key = (f.city || '').toUpperCase()
    if (!cityFacility.has(key)) cityFacility.set(key, [])
    cityFacility.get(key).push(f)
  }

  const groups = []
  for (const prof of professionals) {
    // Try TIN match first
    const tinMatch = prof.provider_tin ? tinFacility.get(prof.provider_tin) : null
    // Fall back to city match
    const cityMatches = cityFacility.get((prof.city || '').toUpperCase()) || []
    const facility = tinMatch || (cityMatches.length > 0 ? cityMatches[0] : null)

    if (facility) {
      const facilityRate = parseFloat(facility.negotiated_rate)
      const profRate = parseFloat(prof.negotiated_rate)
      groups.push({
        ...prof,
        matched_facility: facility.provider_name,
        matched_facility_rate: facilityRate,
        total_estimate: facilityRate + profRate,
        match_type: tinMatch ? 'tin' : 'city',
      })
    } else {
      groups.push({
        ...prof,
        matched_facility: null,
        matched_facility_rate: 0,
        total_estimate: parseFloat(prof.negotiated_rate),
        match_type: 'none',
      })
    }
  }

  return groups.sort((a, b) => a.total_estimate - b.total_estimate)
}

function ResultCard({ result, minRate, maxRate, yourCost, minYourCost, maxYourCost, showYourCost, procedureCategory }) {
  const rate = parseFloat(result.negotiated_rate)
  const isLowest = showYourCost ? yourCost === minYourCost : rate === minRate
  const isHighest = showYourCost ? yourCost === maxYourCost : rate === maxRate
  const relevant = isRelevantSpecialty(result.provider_taxonomy, procedureCategory)

  const displayRate = showYourCost ? yourCost : rate
  const displayMin = showYourCost ? minYourCost : minRate
  const displayMax = showYourCost ? maxYourCost : maxRate

  return (
    <div className={`result-card ${isLowest && relevant ? 'card-lowest' : ''} ${isHighest ? 'card-highest' : ''} ${!relevant ? 'card-mismatch' : ''}`}>
      {!relevant && (
        <div className="specialty-warning">
          Specialty may not match this procedure — verify before relying on this price
        </div>
      )}
      <div className="result-header">
        <div className="provider-info">
          <h3 className="provider-name">{result.provider_name}</h3>
          <span className="provider-type">{result.provider_type === 'organization' ? 'Facility' : 'Individual'}</span>
          {result.provider_taxonomy && (
            <span className={`provider-taxonomy ${!relevant ? 'taxonomy-mismatch' : ''}`}>{result.provider_taxonomy}</span>
          )}
          {result.matched_facility && (
            <span className="facility-match">
              at {result.matched_facility} (facility fee: {formatCurrency(result.matched_facility_rate)})
              {result.match_type === 'city' && <span className="match-approx"> *estimated by city</span>}
            </span>
          )}
        </div>
        <div className="price-section">
          {result.total_estimate && result.matched_facility ? (
            <div className="price-dual">
              <span className="price">{showYourCost ? formatCurrency(yourCost) : formatCurrency(result.total_estimate)}</span>
              <span className="price-label">{showYourCost ? 'your est. total' : 'est. total'}</span>
              <span className="price-breakdown">
                {formatCurrency(rate)} prof + {formatCurrency(result.matched_facility_rate)} facility
              </span>
            </div>
          ) : showYourCost ? (
            <div className="price-dual">
              <span className="price">{formatCurrency(yourCost)}</span>
              <span className="price-label">your cost</span>
              <span className="price-negotiated">{formatCurrency(rate)} negotiated</span>
            </div>
          ) : (
            <span className="price">{formatCurrency(rate)}</span>
          )}
          {isLowest && <span className="badge badge-savings">Lowest</span>}
          {isHighest && <span className="badge badge-expensive">Highest</span>}
        </div>
      </div>
      <div className="result-details">
        <span className="location">{result.city}, {result.state} {result.zip}</span>
        <span className="billing-info">
          {result.billing_class === 'institutional' ? 'Facility fee' : 'Professional fee'}
          {result.setting && ` | ${result.setting}`}
        </span>
        <span className="insurer">{result.insurer_name} - {result.plan_name}</span>
      </div>
      <PriceBar
        rate={displayRate}
        minRate={displayMin}
        maxRate={displayMax}
        isLowest={isLowest}
        isHighest={isHighest}
      />
      {isLowest && displayMax > displayRate && (
        <div className="savings-callout">
          Save up to {formatCurrency(displayMax - displayRate)} vs. highest price
        </div>
      )}
    </div>
  )
}

function InsurancePanel({ insurance, setInsurance, show, setShow }) {
  if (!show) {
    return (
      <button className="personalize-btn" onClick={() => setShow(true)}>
        Personalize: Enter your insurance details to see YOUR cost
      </button>
    )
  }

  return (
    <div className="insurance-panel">
      <div className="panel-header">
        <h3>Your Insurance</h3>
        <button className="panel-close" onClick={() => setShow(false)}>Hide</button>
      </div>
      <p className="panel-subtitle">
        Enter your plan details to see what you'd actually pay out of pocket.
      </p>
      <div className="insurance-fields">
        <div className="field">
          <label>Deductible remaining this year</label>
          <div className="input-group">
            <span className="input-prefix">$</span>
            <input
              type="number"
              min="0"
              step="100"
              value={insurance.deductibleRemaining}
              onChange={(e) => setInsurance({ ...insurance, deductibleRemaining: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <span className="field-hint">How much of your deductible you haven't met yet</span>
        </div>
        <div className="field">
          <label>Your coinsurance rate</label>
          <div className="input-group">
            <input
              type="number"
              min="0"
              max="100"
              step="5"
              value={insurance.coinsurancePct}
              onChange={(e) => setInsurance({ ...insurance, coinsurancePct: parseFloat(e.target.value) || 0 })}
            />
            <span className="input-suffix">%</span>
          </div>
          <span className="field-hint">Your share after deductible (e.g., 20 for an 80/20 plan)</span>
        </div>
        <div className="field">
          <label>Out-of-pocket max remaining</label>
          <div className="input-group">
            <span className="input-prefix">$</span>
            <input
              type="number"
              min="0"
              step="500"
              value={insurance.oopMaxRemaining}
              onChange={(e) => setInsurance({ ...insurance, oopMaxRemaining: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <span className="field-hint">Leave at 0 if you don't know (we won't cap)</span>
        </div>
      </div>
    </div>
  )
}

function App() {
  const [selectedProcedure, setSelectedProcedure] = useState(null)
  const [selectedCategory, setSelectedCategory] = useState(null)
  const [cityFilter, setCityFilter] = useState('')
  const [billingClassFilter, setBillingClassFilter] = useState('all')
  const [planFilter, setPlanFilter] = useState('all')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [showInsurance, setShowInsurance] = useState(false)
  const [insurance, setInsurance] = useState({
    deductibleRemaining: 2000,
    coinsurancePct: 20,
    oopMaxRemaining: 0,
  })

  const showYourCost = showInsurance && (insurance.deductibleRemaining > 0 || insurance.coinsurancePct > 0)

  async function searchPrices(procedureCode) {
    setLoading(true)
    setSelectedProcedure(procedureCode)
    try {
      if (DEMO_MODE) {
        const demoResults = getDemoData(procedureCode)
        setResults(demoResults)
      } else {
        const { data, error } = await supabase.rpc('search_prices', {
          p_billing_code: procedureCode,
          p_limit: 500,
        })
        if (error) throw error
        setResults(data || [])
      }
    } catch (err) {
      console.error('Search error:', err)
      setResults([])
    }
    setLoading(false)
  }

  const insuranceParams = {
    deductibleRemaining: insurance.deductibleRemaining,
    coinsuranceRate: insurance.coinsurancePct / 100,
    oopMaxRemaining: insurance.oopMaxRemaining > 0 ? insurance.oopMaxRemaining : Infinity,
  }

  // Get unique plan names for the filter dropdown
  const availablePlans = [...new Set(results.map(r => r.plan_name))].sort()

  const filteredResults = results.filter(r => {
    const rate = parseFloat(r.negotiated_rate)
    if (rate <= 0) return false // Exclude $0 rates (bundled payments)
    if (billingClassFilter !== 'all' && r.billing_class !== billingClassFilter) return false
    if (planFilter !== 'all' && r.plan_name !== planFilter) return false
    if (cityFilter && !r.city?.toLowerCase().includes(cityFilter.toLowerCase())) return false
    return true
  })

  // Try to create grouped view (professional + matched facility = total)
  const grouped = billingClassFilter === 'all' ? groupByFacility(filteredResults) : null

  // Use grouped results if available and we're showing "all", otherwise individual
  const displayResults = grouped && grouped.length > 0 ? grouped : filteredResults

  // Compute your-cost for each result (use total_estimate for grouped results)
  const resultsWithCost = displayResults.map(r => {
    const baseRate = r.total_estimate || parseFloat(r.negotiated_rate)
    return {
      ...r,
      yourCost: calculateYourCost(baseRate, insuranceParams),
    }
  })

  // Compute stats on what's actually displayed (totals when grouped, individual otherwise)
  const isGrouped = grouped && grouped.length > 0
  const stats = (() => {
    if (!resultsWithCost.length) return null
    const rates = resultsWithCost.map(r => r.total_estimate || parseFloat(r.negotiated_rate))
    const sorted = [...rates].sort((a, b) => a - b)
    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      median: sorted[Math.floor(sorted.length / 2)],
      count: sorted.length,
      spread: sorted[sorted.length - 1] - sorted[0],
      isGrouped,
    }
  })()

  // Sort by your-cost if personalized, otherwise by rate/total
  const sortedResults = showYourCost
    ? [...resultsWithCost].sort((a, b) => a.yourCost - b.yourCost)
    : [...resultsWithCost].sort((a, b) => {
        const aRate = a.total_estimate || parseFloat(a.negotiated_rate)
        const bRate = b.total_estimate || parseFloat(b.negotiated_rate)
        return aRate - bRate
      })

  const rateAccessor = (r) => r.total_estimate || parseFloat(r.negotiated_rate)
  const minRate = sortedResults.length ? Math.min(...sortedResults.map(rateAccessor)) : 0
  const maxRate = sortedResults.length ? Math.max(...sortedResults.map(rateAccessor)) : 0
  const minYourCost = sortedResults.length ? Math.min(...sortedResults.map(r => r.yourCost)) : 0
  const maxYourCost = sortedResults.length ? Math.max(...sortedResults.map(r => r.yourCost)) : 0

  const proceduresByCategory = PROCEDURES.filter(p =>
    !selectedCategory || p.category === selectedCategory
  )

  const selectedProcInfo = PROCEDURES.find(p => p.code === selectedProcedure)

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <h1>ClearPrice</h1>
          <p className="tagline">Know what healthcare really costs in Wisconsin</p>
        </div>
      </header>

      <main className="main">
        {!selectedProcedure ? (
          <div className="search-section">
            <h2>What procedure do you need?</h2>
            <p className="search-subtitle">
              Select a procedure to compare prices across providers and facilities in Wisconsin.
              Same procedure. Same insurance. Wildly different prices.
            </p>

            <div className="category-filters">
              <button
                className={`cat-btn ${!selectedCategory ? 'active' : ''}`}
                onClick={() => setSelectedCategory(null)}
              >All</button>
              {Object.entries(CATEGORIES).map(([key, label]) => (
                <button
                  key={key}
                  className={`cat-btn ${selectedCategory === key ? 'active' : ''}`}
                  onClick={() => setSelectedCategory(key)}
                >{label}</button>
              ))}
            </div>

            <div className="procedure-grid">
              {proceduresByCategory.map(proc => (
                <button
                  key={proc.code}
                  className="procedure-card"
                  onClick={() => searchPrices(proc.code)}
                >
                  <span className="proc-name">{proc.name}</span>
                  <span className="proc-code">CPT {proc.code}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="results-section">
            <button className="back-btn" onClick={() => { setSelectedProcedure(null); setResults([]); setPlanFilter('all'); setCityFilter('') }}>
              &larr; Back to procedures
            </button>

            <h2>{selectedProcInfo?.name}</h2>
            <p className="proc-code-label">CPT {selectedProcedure}</p>

            {stats && (
              <div className="stats-bar">
                {stats.isGrouped && (
                  <div className="stat stat-full-width">
                    <span className="stats-note">Showing estimated totals (professional + facility fee)</span>
                  </div>
                )}
                <div className="stat">
                  <span className="stat-label">Lowest{stats.isGrouped ? ' total' : ''}</span>
                  <span className="stat-value stat-low">{formatCurrency(stats.min)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Median</span>
                  <span className="stat-value">{formatCurrency(stats.median)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Highest{stats.isGrouped ? ' total' : ''}</span>
                  <span className="stat-value stat-high">{formatCurrency(stats.max)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Spread</span>
                  <span className="stat-value stat-spread">{formatCurrency(stats.spread)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Providers</span>
                  <span className="stat-value">{stats.count}</span>
                </div>
              </div>
            )}

            <InsurancePanel
              insurance={insurance}
              setInsurance={setInsurance}
              show={showInsurance}
              setShow={setShowInsurance}
            />

            <div className="filters-row">
              <select
                value={planFilter}
                onChange={(e) => setPlanFilter(e.target.value)}
                className="plan-select"
              >
                <option value="all">All insurers / plans ({availablePlans.length})</option>
                {availablePlans.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Filter by city..."
                value={cityFilter}
                onChange={(e) => setCityFilter(e.target.value)}
                className="city-input"
              />
              <select
                value={billingClassFilter}
                onChange={(e) => setBillingClassFilter(e.target.value)}
                className="class-select"
              >
                <option value="all">All (facility + professional)</option>
                <option value="institutional">Facility fees only</option>
                <option value="professional">Professional fees only</option>
              </select>
            </div>

            {filteredResults.length > 0 && (() => {
              const hasInst = filteredResults.some(r => r.billing_class === 'institutional')
              const hasProf = filteredResults.some(r => r.billing_class === 'professional')
              if (hasInst && hasProf) return (
                <div className="dual-fee-notice">
                  <strong>Two types of charges:</strong> Hospital procedures typically have both a <em>facility fee</em> (hospital's
                  charge) and a <em>professional fee</em> (surgeon's charge). Use the filter above to view them separately,
                  or look at both to estimate your total cost. Your total = facility fee + professional fee.
                </div>
              )
              if (hasInst && !hasProf) return (
                <div className="dual-fee-notice notice-warning">
                  These are <strong>facility fees only</strong>. Your surgeon/doctor will bill separately (professional fee).
                  Your total out-of-pocket will be higher than the amounts shown.
                </div>
              )
              if (!hasInst && hasProf) return (
                <div className="dual-fee-notice notice-info">
                  These are <strong>professional fees only</strong> (surgeon/doctor charges). If performed at a hospital or
                  surgical center, there will also be a facility fee.
                </div>
              )
              return null
            })()}

            {loading ? (
              <div className="loading">Searching prices...</div>
            ) : sortedResults.length > 0 ? (
              <div className="results-list">
                {sortedResults.map((r, i) => (
                  <ResultCard
                    key={i}
                    result={r}
                    minRate={minRate}
                    maxRate={maxRate}
                    yourCost={r.yourCost}
                    minYourCost={minYourCost}
                    maxYourCost={maxYourCost}
                    showYourCost={showYourCost}
                    procedureCategory={selectedProcInfo?.category}
                  />
                ))}
              </div>
            ) : (
              <div className="no-results">No results found. Try adjusting your filters.</div>
            )}
          </div>
        )}
      </main>

      <footer className="footer">
        <p>
          Data sourced from federally-mandated insurer Machine-Readable Files
          under the Transparency in Coverage Rule.
          All prices are negotiated rates — your actual cost depends on your deductible and coinsurance.
        </p>
        <p className="footer-note">
          ClearPrice is for informational purposes. Always verify with your insurer before making decisions.
        </p>
      </footer>
    </div>
  )
}

// Demo data from our actual parsed WI files
function getDemoData(code) {
  const demoSets = {
    '27447': [
      { provider_name: 'OAK LEAF SURGICAL HOSPITAL LLC', provider_type: 'organization', provider_taxonomy: 'General Acute Care Hospital', city: 'ALTOONA', state: 'WI', zip: '54720', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 7265.39, billing_class: 'institutional', setting: 'outpatient' },
      { provider_name: 'ST. CROIX REGIONAL MEDICAL CENTER', provider_type: 'organization', provider_taxonomy: 'Critical Access Hospital', city: 'SAINT CROIX FALLS', state: 'WI', zip: '54024', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 5630, billing_class: 'institutional', setting: 'outpatient' },
      { provider_name: 'LADD MEMORIAL HOSPITAL', provider_type: 'organization', provider_taxonomy: 'Critical Access Hospital', city: 'OSCEOLA', state: 'WI', zip: '54020', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 6412.22, billing_class: 'institutional', setting: 'outpatient' },
      { provider_name: 'GUNDERSEN LUTHERAN MEDICAL CENTER INC', provider_type: 'organization', provider_taxonomy: 'ESRD Treatment', city: 'LA CROSSE', state: 'WI', zip: '54601', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 13868.04, billing_class: 'institutional', setting: 'inpatient' },
      { provider_name: 'MAYO CLINIC HEALTH SYSTEM-NW WISCONSIN', provider_type: 'organization', provider_taxonomy: 'General Acute Care', city: 'EAU CLAIRE', state: 'WI', zip: '54703', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 13495.02, billing_class: 'institutional', setting: 'inpatient' },
      { provider_name: 'AMERY REGIONAL MEDICAL CENTER', provider_type: 'organization', provider_taxonomy: 'Critical Access Hospital', city: 'AMERY', state: 'WI', zip: '54001', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 18166.30, billing_class: 'institutional', setting: 'inpatient' },
      { provider_name: 'RUSTY BRAND', provider_type: 'individual', provider_taxonomy: 'Orthopaedic Surgery, Adult Reconstructive', city: 'EAU CLAIRE', state: 'WI', zip: '54702', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 13308.01, billing_class: 'professional', setting: '' },
      { provider_name: 'DAVID NORDIN', provider_type: 'individual', provider_taxonomy: 'Orthopaedic Surgery', city: 'SAINT CROIX FALLS', state: 'WI', zip: '54024', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 2291.93, billing_class: 'professional', setting: '' },
      { provider_name: 'CONNOR OLSON', provider_type: 'individual', provider_taxonomy: 'Athletic Trainer', city: 'ALTOONA', state: 'WI', zip: '54720', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 1908.9, billing_class: 'professional', setting: '' },
      { provider_name: 'ASHLEY REGIMBAL', provider_type: 'individual', provider_taxonomy: 'Nurse Practitioner, Family', city: 'CUMBERLAND', state: 'WI', zip: '54829', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 305.60, billing_class: 'professional', setting: '' },
    ],
  }
  return demoSets[code] || demoSets['27447']
}

export default App
