import { useState, useEffect } from 'react'
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

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
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

function ResultCard({ result, minRate, maxRate }) {
  const isLowest = result.negotiated_rate === minRate
  const isHighest = result.negotiated_rate === maxRate

  return (
    <div className={`result-card ${isLowest ? 'card-lowest' : ''} ${isHighest ? 'card-highest' : ''}`}>
      <div className="result-header">
        <div className="provider-info">
          <h3 className="provider-name">{result.provider_name}</h3>
          <span className="provider-type">{result.provider_type === 'organization' ? 'Facility' : 'Individual'}</span>
          {result.provider_taxonomy && (
            <span className="provider-taxonomy">{result.provider_taxonomy}</span>
          )}
        </div>
        <div className="price-section">
          <span className="price">{formatCurrency(result.negotiated_rate)}</span>
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
        rate={result.negotiated_rate}
        minRate={minRate}
        maxRate={maxRate}
        isLowest={isLowest}
        isHighest={isHighest}
      />
      {isLowest && maxRate > minRate && (
        <div className="savings-callout">
          Save up to {formatCurrency(maxRate - minRate)} vs. highest price
        </div>
      )}
    </div>
  )
}

function App() {
  const [selectedProcedure, setSelectedProcedure] = useState(null)
  const [selectedCategory, setSelectedCategory] = useState(null)
  const [cityFilter, setCityFilter] = useState('')
  const [billingClassFilter, setBillingClassFilter] = useState('all')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState(null)

  async function searchPrices(procedureCode) {
    setLoading(true)
    setSelectedProcedure(procedureCode)

    try {
      if (DEMO_MODE) {
        // Demo data from our actual parsed files
        const demoResults = getDemoData(procedureCode)
        setResults(demoResults)
        computeStats(demoResults)
      } else {
        const { data, error } = await supabase.rpc('search_prices', {
          p_billing_code: procedureCode,
          p_limit: 100,
          ...(cityFilter ? { p_city: cityFilter } : {}),
        })
        if (error) throw error
        setResults(data || [])
        computeStats(data || [])
      }
    } catch (err) {
      console.error('Search error:', err)
      setResults([])
    }
    setLoading(false)
  }

  function computeStats(data) {
    if (!data.length) { setStats(null); return }
    const rates = data.map(r => r.negotiated_rate)
    const min = Math.min(...rates)
    const max = Math.max(...rates)
    const median = rates.sort((a, b) => a - b)[Math.floor(rates.length / 2)]
    setStats({ min, max, median, count: rates.length, spread: max - min })
  }

  const filteredResults = results.filter(r => {
    if (billingClassFilter !== 'all' && r.billing_class !== billingClassFilter) return false
    if (cityFilter && !r.city?.toLowerCase().includes(cityFilter.toLowerCase())) return false
    return true
  }).sort((a, b) => a.negotiated_rate - b.negotiated_rate)

  const minRate = filteredResults.length ? Math.min(...filteredResults.map(r => r.negotiated_rate)) : 0
  const maxRate = filteredResults.length ? Math.max(...filteredResults.map(r => r.negotiated_rate)) : 0

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
            <button className="back-btn" onClick={() => { setSelectedProcedure(null); setResults([]); setStats(null) }}>
              &larr; Back to procedures
            </button>

            <h2>{selectedProcInfo?.name}</h2>
            <p className="proc-code-label">CPT {selectedProcedure}</p>

            {stats && (
              <div className="stats-bar">
                <div className="stat">
                  <span className="stat-label">Lowest</span>
                  <span className="stat-value stat-low">{formatCurrency(stats.min)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Median</span>
                  <span className="stat-value">{formatCurrency(stats.median)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Highest</span>
                  <span className="stat-value stat-high">{formatCurrency(stats.max)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Price Spread</span>
                  <span className="stat-value stat-spread">{formatCurrency(stats.spread)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Providers</span>
                  <span className="stat-value">{stats.count}</span>
                </div>
              </div>
            )}

            <div className="filters-row">
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

            {loading ? (
              <div className="loading">Searching prices...</div>
            ) : filteredResults.length > 0 ? (
              <div className="results-list">
                {filteredResults.map((r, i) => (
                  <ResultCard key={i} result={r} minRate={minRate} maxRate={maxRate} />
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
      { provider_name: 'MOLLY WILLENBRING', provider_type: 'individual', provider_taxonomy: 'Nurse Practitioner, Women\'s Health', city: 'LA CROSSE', state: 'WI', zip: '54601', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 1846.10, billing_class: 'professional', setting: '' },
      { provider_name: 'ASHLEY OBRIEN', provider_type: 'individual', provider_taxonomy: 'Physician Assistant', city: 'ALTOONA', state: 'WI', zip: '54720', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 1297.29, billing_class: 'professional', setting: '' },
      { provider_name: 'ASHLEY REGIMBAL', provider_type: 'individual', provider_taxonomy: 'Nurse Practitioner, Family', city: 'CUMBERLAND', state: 'WI', zip: '54829', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 305.60, billing_class: 'professional', setting: '' },
    ],
    '45380': [
      { provider_name: 'GUNDERSEN LUTHERAN MEDICAL CENTER', provider_type: 'organization', provider_taxonomy: 'General Acute Care', city: 'LA CROSSE', state: 'WI', zip: '54601', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 3245.50, billing_class: 'institutional', setting: 'outpatient' },
      { provider_name: 'OAK LEAF SURGICAL HOSPITAL', provider_type: 'organization', provider_taxonomy: 'General Acute Care', city: 'ALTOONA', state: 'WI', zip: '54720', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 1890.00, billing_class: 'institutional', setting: 'outpatient' },
      { provider_name: 'MAYO CLINIC HEALTH SYSTEM-NW WI', provider_type: 'organization', provider_taxonomy: 'General Acute Care', city: 'EAU CLAIRE', state: 'WI', zip: '54703', insurer_name: 'Medica', plan_name: 'Medica Choice Passport-WI', negotiated_rate: 2780.00, billing_class: 'institutional', setting: 'outpatient' },
    ],
  }

  return demoSets[code] || demoSets['27447'] // Fall back to knee replacement data
}

export default App
