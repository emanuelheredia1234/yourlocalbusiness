import type {
  BookingType,
  ImageStyleId,
  PostPlatform,
  PostType,
  PriceModel,
  ProductFormat,
  ServicePriceModel,
  SocialPlatform,
  VideoStyleId,
} from '@/lib/types';

// ───────────────────────── Niche intelligence ─────────────────────────
// Each profile is a compact market brief the built-in engine reasons from:
// who buys, what hurts, what they want, the vocabulary they use, and what they doubt.

export type CalcKind =
  | 'tax'
  | 'macro'
  | 'roi'
  | 'mortgage'
  | 'time'
  | 'grade'
  | 'recipe'
  | 'routine'
  | 'budget'
  | 'pricing'
  | 'salary'
  | 'margin'
  | 'habit'
  | 'quote'
  | 'food-cost';

export interface NicheProfile {
  id: string;
  label: string;
  match: string[];
  audiences: string[];
  pains: string[];
  desires: string[];
  outcomes: string[];
  terms: string[];
  objections: string[];
  mistakes: string[];
  myths: string[];
  quickWins: string[];
  hashtags: string[];
  icon: string;
  palettes: [string, string, string][];
  nameRoots: string[];
  categories: string[];
  demand: number;
  competition: number;
  priceMult: number;
  calc: CalcKind;
  local?: boolean;
}

export const NICHES: NicheProfile[] = [
  {
    id: 'personal-finance',
    label: 'Personal Finance',
    match: ['personal finance', 'finance', 'money', 'budget', 'budgeting', 'tax', 'taxes', 'invest', 'investing', 'debt', 'saving', 'savings', 'credit', 'retire', 'retirement', 'frugal', 'wealth', 'bookkeeping', 'financial', 'paycheck'],
    audiences: ['freelancers', 'young professionals', 'couples', 'side hustlers', 'first-time investors', 'self-employed creatives'],
    pains: ['surprise tax bills', 'receipts scattered across apps and inboxes', 'never knowing what is safe to spend', 'irregular income that makes planning feel impossible', 'money anxiety every time a bill arrives', 'late fees and forgotten subscriptions'],
    desires: ['calm, predictable money', 'a plan that survives irregular months', 'confidence at tax time', 'an emergency fund that actually grows', 'more take-home pay without more hours'],
    outcomes: ['set aside the right amount for taxes every month', 'cut money admin to 20 minutes a week', 'build a 3-month safety buffer', 'stop paying late fees for good', 'know your real monthly number'],
    terms: ['cash flow', 'quarterly estimates', 'deductions', 'sinking funds', 'net worth', 'savings rate', 'expense categories', 'tax buckets'],
    objections: ["I'm not a numbers person", "I don't have time to track every expense", "I've tried budgeting apps and quit", 'My income changes too much to plan'],
    mistakes: ['mixing business and personal spending in one account', 'saving whatever is left at the end of the month', 'waiting until April to think about taxes', 'tracking every coffee instead of the big five categories'],
    myths: ['You need a finance degree to manage money well', 'Budgeting means cutting out everything fun', 'Freelancers can only plan once income is stable', 'Tax prep is a once-a-year problem'],
    quickWins: ['open a separate account just for taxes today', 'set a 15-minute weekly money date on your calendar', 'auto-transfer 25% of every client payment into savings', 'tag recurring subscriptions and cancel the two you forgot about'],
    hashtags: ['#personalfinance', '#moneytips', '#budgeting', '#freelancelife', '#taxtips', '#financialfreedom', '#moneymindset', '#smallbusinesstips'],
    icon: 'wallet',
    palettes: [['#156343', '#0E3B2A', '#F2B33D'], ['#1F4E79', '#0F2A44', '#5FD0A0'], ['#2D2A6E', '#16153A', '#F4A259']],
    nameRoots: ['Ledger', 'Penny', 'Mint', 'Vault', 'Tally', 'Nest', 'Margin', 'Coin', 'Clear', 'Kept', 'Sum'],
    categories: ['Freelancer Tax Tracking', 'Debt Payoff Plans', 'Budgeting for Couples', 'First-Time Investing', 'Emergency Fund Building', 'Side Hustle Bookkeeping'],
    demand: 0.86,
    competition: 0.72,
    priceMult: 1,
    calc: 'tax',
  },
  {
    id: 'fitness',
    label: 'Fitness & Training',
    match: ['fitness', 'workout', 'workouts', 'gym', 'strength', 'mobility', 'yoga', 'pilates', 'running', 'runner', 'training', 'postpartum', 'exercise', 'athlete', 'stretch', 'stretching', 'cardio', 'marathon', 'calisthenics', 'kettlebell', 'personal trainer', 'crossfit', 'weight training'],
    audiences: ['busy professionals', 'new moms', 'beginners over 40', 'home gym owners', 'runners', 'desk workers'],
    pains: ['workouts that never fit a packed schedule', 'nagging back and hip stiffness', 'starting strong and quitting by week three', 'not knowing which exercises are actually safe', 'plateaus after months of effort'],
    desires: ['feeling strong in everyday life', 'moving without pain', 'a routine that sticks', 'visible progress in weeks, not years', 'confidence in the gym'],
    outcomes: ['train three times a week in 30 minutes or less', 'reduce morning stiffness in 14 days', 'add 20% to your main lifts in 8 weeks', 'run your first 5K pain-free'],
    terms: ['progressive overload', 'mobility flow', 'core stability', 'RPE', 'deload week', 'form cues', 'warm-up sequence'],
    objections: ["I don't have time to work out", "I've tried programs before and quit", "I'm worried about getting injured", "I don't have equipment"],
    mistakes: ['skipping the warm-up to save time', 'doing random workouts with no progression', 'training through pain instead of modifying', 'chasing soreness as proof it worked'],
    myths: ['You need an hour a day to see results', 'Stretching alone fixes stiffness', 'Lifting weights makes you bulky', 'More sweat means a better workout'],
    quickWins: ['add a 5-minute mobility flow before work', 'log just one number per workout', 'swap one sitting hour for a 10-minute walk', 'pick 3 compound moves and master the form'],
    hashtags: ['#fitnessmotivation', '#mobility', '#strengthtraining', '#homeworkout', '#fitover40', '#postpartumfitness', '#fitnesstips', '#movebetter'],
    icon: 'dumbbell',
    palettes: [['#E4572E', '#1B1B1E', '#F6C445'], ['#0F7173', '#05302F', '#F07167'], ['#3A0CA3', '#14053D', '#F72585']],
    nameRoots: ['Forge', 'Stride', 'Core', 'Lift', 'Motion', 'Kinetic', 'Rise', 'Flex', 'Peak', 'Steady'],
    categories: ['Postpartum Mobility', 'Strength Training for Beginners', 'Desk Worker Back Relief', 'Couch to 5K', 'Kettlebell Home Workouts', 'Over-40 Strength'],
    demand: 0.9,
    competition: 0.82,
    priceMult: 0.95,
    calc: 'macro',
  },
  {
    id: 'health-nutrition',
    label: 'Health & Nutrition',
    match: ['nutrition', 'diet', 'meal plan', 'health', 'wellness', 'sleep', 'gut', 'hormone', 'hormones', 'keto', 'vegan', 'healthy eating', 'longevity', 'weight loss', 'protein', 'dietitian', 'supplement', 'fasting', 'blood sugar', 'perimenopause', 'menopause'],
    audiences: ['busy parents', 'women in perimenopause', 'plant-based beginners', 'shift workers', 'people managing blood sugar'],
    pains: ['afternoon energy crashes', 'confusing, contradictory nutrition advice', 'meal planning that eats up Sunday', 'cravings that derail good weeks', 'poor sleep that wrecks everything else'],
    desires: ['steady energy all day', 'meals the whole family eats', 'a simple plan without counting every bite', 'better sleep and calmer mornings'],
    outcomes: ['plan a week of meals in 20 minutes', 'cut afternoon crashes in 10 days', 'hit your protein target without supplements', 'fall asleep 30 minutes faster'],
    terms: ['macros', 'protein targets', 'blood sugar balance', 'meal prep', 'fiber', 'sleep hygiene', 'whole foods'],
    objections: ['Healthy food is too expensive', "My family won't eat it", "I don't have time to cook", "I've tried diets and gained it back"],
    mistakes: ['skipping breakfast then overeating at night', 'cutting entire food groups overnight', 'relying on willpower instead of a plan', 'ignoring protein at breakfast'],
    myths: ['Carbs are the enemy', 'Healthy eating means bland food', 'You need expensive supplements', 'Eating late always causes weight gain'],
    quickWins: ['add 25g of protein to breakfast', 'prep two sheet-pan dinners on Sunday', 'drink a glass of water before each coffee', 'set a consistent bedtime alarm'],
    hashtags: ['#nutritiontips', '#healthyeating', '#mealprep', '#guthealth', '#wellnessjourney', '#healthyhabits', '#eatwell'],
    icon: 'leaf',
    palettes: [['#2A9D8F', '#1D3557', '#E9C46A'], ['#6A994E', '#283618', '#F2CC8F'], ['#BC4749', '#386641', '#F2E8CF']],
    nameRoots: ['Nourish', 'Root', 'Bloom', 'Vital', 'Whole', 'Sprout', 'Ember', 'Thrive', 'Harvest', 'Glow'],
    categories: ['Family Meal Planning', 'Perimenopause Nutrition', 'Plant-Based Protein', 'Gut Health Reset', 'Blood Sugar Balance', 'Sleep Optimization'],
    demand: 0.87,
    competition: 0.78,
    priceMult: 0.95,
    calc: 'macro',
  },
  {
    id: 'b2b-sales',
    label: 'B2B SaaS & Sales',
    match: ['saas', 'b2b', 'startup', 'startups', 'product-led', 'churn', 'onboarding', 'sales', 'pipeline', 'cold outreach', 'outreach', 'cold email', 'crm', 'lead gen', 'lead generation', 'revops', 'founder', 'account executive', 'sdr', 'prospecting', 'demo', 'enterprise'],
    audiences: ['B2B founders', 'SDR teams', 'early-stage startups', 'customer success leads', 'solo consultants selling to businesses'],
    pains: ['cold emails that get ignored', 'a pipeline that dries up between launches', 'demos that never convert', 'churn that quietly erases growth', 'hours lost to manual prospecting'],
    desires: ['a predictable pipeline', 'meetings booked on autopilot', 'higher reply rates without spammy tactics', 'net revenue retention above 100%'],
    outcomes: ['book 10+ qualified meetings a month', 'double cold email reply rates', 'cut prospecting time by 60%', 'reduce churn by 20% in a quarter'],
    terms: ['ICP', 'reply rate', 'sequence', 'pipeline velocity', 'ACV', 'churn', 'activation', 'follow-up cadence'],
    objections: ['Cold outreach feels spammy', 'Our market is too niche', 'We tried an agency and it flopped', "We don't have time to personalize"],
    mistakes: ['pitching in the first line instead of earning attention', 'sending the same template to every persona', 'giving up after one follow-up', 'measuring opens instead of replies and meetings'],
    myths: ['Cold email is dead', 'Longer emails show more value', 'You need huge lists to book meetings', 'Personalization does not scale'],
    quickWins: ['rewrite your first line around a trigger event', 'add a 3-touch follow-up sequence', 'narrow your list to one ICP for a week', 'replace "quick call?" with a specific low-friction ask'],
    hashtags: ['#b2bsales', '#saas', '#coldemail', '#salestips', '#startups', '#leadgeneration', '#revops', '#founders'],
    icon: 'trending-up',
    palettes: [['#3D5AFE', '#0B1340', '#00E5A0'], ['#1E293B', '#0B1020', '#38BDF8'], ['#5B21B6', '#1E0B45', '#FBBF24']],
    nameRoots: ['Signal', 'Pipeline', 'Reply', 'Outbound', 'Vector', 'Cadence', 'Lever', 'Booked', 'Relay', 'Apex'],
    categories: ['Cold Outreach', 'SaaS Onboarding', 'Churn Reduction', 'Sales Pipeline Templates', 'LinkedIn Prospecting', 'Founder-Led Sales'],
    demand: 0.82,
    competition: 0.66,
    priceMult: 1.9,
    calc: 'roi',
  },
  {
    id: 'marketing',
    label: 'Marketing & Content',
    match: ['marketing', 'social media', 'instagram', 'tiktok', 'content', 'content creation', 'seo', 'email marketing', 'ads', 'branding', 'copywriting', 'influencer', 'creator', 'creators', 'youtube', 'newsletter', 'ugc', 'reels', 'personal brand', 'digital marketing'],
    audiences: ['small business owners', 'content creators', 'coaches and consultants', 'solo marketers', 'Etsy and Shopify sellers'],
    pains: ['posting daily and hearing crickets', 'never knowing what to post next', 'followers who never turn into customers', 'burning out on content creation', 'algorithm changes that tank reach overnight'],
    desires: ['a content system that runs in two hours a week', 'followers who actually buy', 'a recognizable brand voice', 'consistent growth without dancing on camera'],
    outcomes: ['plan 30 days of content in one afternoon', 'grow an engaged email list to 1,000', 'turn one idea into 10 posts', 'increase saves and shares by 3x'],
    terms: ['content pillars', 'hooks', 'engagement rate', 'repurposing', 'lead magnet', 'funnel', 'call to action', 'batching'],
    objections: ["I don't have time to post every day", 'My niche is boring', "I'm not comfortable on camera", "Social media doesn't work for my business"],
    mistakes: ['posting without a clear call to action', 'chasing trends that do not fit the brand', 'talking about features instead of outcomes', 'never repurposing content that already worked'],
    myths: ['You have to post every single day', 'Going viral is the goal', 'Hashtags are all that matter', 'You need a big following to make sales'],
    quickWins: ['rewrite your bio to state who you help and how', 'turn your best post into a carousel', 'add one clear CTA to every caption this week', 'batch three posts in a single 45-minute session'],
    hashtags: ['#marketingtips', '#contentcreator', '#socialmediatips', '#smallbusiness', '#contentstrategy', '#branding', '#instagramtips', '#growthmarketing'],
    icon: 'megaphone',
    palettes: [['#FF5A5F', '#1F1D36', '#FFC857'], ['#7B2CBF', '#240046', '#FF9E00'], ['#00A6A6', '#06393A', '#F49D37']],
    nameRoots: ['Amplify', 'Spark', 'Hook', 'Echo', 'Loop', 'Buzz', 'Story', 'Pulse', 'Signal', 'Bright'],
    categories: ['Content Batching', 'Instagram Growth', 'Email List Building', 'Short-Form Video', 'Personal Branding', 'Copywriting for Small Business'],
    demand: 0.88,
    competition: 0.85,
    priceMult: 1.1,
    calc: 'roi',
  },
  {
    id: 'real-estate',
    label: 'Real Estate',
    match: ['real estate', 'realtor', 'property', 'properties', 'rental', 'airbnb', 'landlord', 'mortgage', 'home buying', 'homebuyer', 'flip', 'house flipping', 'short-term rental', 'broker', 'realty', 'investment property', 'first-time buyer', 'house hacking'],
    audiences: ['first-time homebuyers', 'new real estate agents', 'short-term rental hosts', 'small landlords', 'house hackers'],
    pains: ['bidding wars that end in heartbreak', 'listings that sit for weeks', 'not knowing what a property will really cash flow', 'leads that ghost after one showing', 'turnovers and vacancies that wipe out profit'],
    desires: ['buying with confidence', 'a steady flow of qualified leads', '5-star guest reviews', 'predictable rental income'],
    outcomes: ['analyze a deal in 10 minutes', 'book 3x more showings', 'raise nightly rates by 15%', 'cut vacancy days in half'],
    terms: ['cap rate', 'cash-on-cash return', 'closing costs', 'pre-approval', 'occupancy rate', 'comps', 'escrow', 'ADR'],
    objections: ['The market is too expensive right now', "I don't have enough for a down payment", 'Agents already have too much competition', 'Managing guests is exhausting'],
    mistakes: ['skipping a real cash flow analysis', 'pricing a listing on emotion instead of comps', 'waiting for the perfect market', 'ignoring maintenance reserves'],
    myths: ['You need 20% down to buy', 'Renting is always throwing money away', 'Short-term rentals are passive income', 'More photos always sell faster'],
    quickWins: ['get pre-approved before touring', 'set up a comps alert for your target zip code', 'add a digital guidebook for guests', 'follow up with every lead within 5 minutes'],
    hashtags: ['#realestate', '#realtor', '#firsttimehomebuyer', '#realestateinvesting', '#airbnbhost', '#househunting', '#rentalproperty'],
    icon: 'house',
    palettes: [['#264653', '#14262E', '#E9C46A'], ['#9C6644', '#3B2416', '#DDB892'], ['#1D3557', '#0B1626', '#E63946']],
    nameRoots: ['Keystone', 'Hearth', 'Harbor', 'Threshold', 'Brick', 'Gable', 'Porch', 'Haven', 'Parcel', 'Cornerstone'],
    categories: ['First-Time Homebuyer Guide', 'Short-Term Rental Hosting', 'Rental Property Analysis', 'New Agent Lead Generation', 'House Hacking', 'Listing Photography'],
    demand: 0.83,
    competition: 0.74,
    priceMult: 1.4,
    calc: 'mortgage',
  },
  {
    id: 'productivity',
    label: 'Productivity & Systems',
    match: ['productivity', 'notion', 'time management', 'focus', 'habits', 'habit', 'planning', 'planner', 'organization', 'adhd', 'remote work', 'goals', 'to-do', 'task management', 'second brain', 'obsidian', 'deep work', 'routine', 'routines'],
    audiences: ['remote workers', 'students', 'adults with ADHD', 'freelancers juggling clients', 'new managers'],
    pains: ['ending busy days with nothing important done', 'apps and lists scattered everywhere', 'constant context switching', 'big goals that never leave January', 'notifications that hijack focus'],
    desires: ['clear priorities every morning', 'one trusted system for everything', 'deep focus on demand', 'finishing the week ahead instead of behind'],
    outcomes: ['plan your week in 15 minutes', 'reclaim 5 focused hours a week', 'hit quarterly goals instead of abandoning them', 'cut daily task lists to the three that matter'],
    terms: ['time blocking', 'weekly review', 'second brain', 'dashboard', 'priority matrix', 'deep work', 'habit stacking'],
    objections: ["I've tried planners and stopped using them", 'My work is too unpredictable to plan', 'Setting up a system takes forever', "I'm just not a disciplined person"],
    mistakes: ['writing 20 tasks for one day', 'using five different apps for one workflow', 'planning the day without checking the calendar', 'skipping the weekly review'],
    myths: ['Productive people work longer hours', 'Multitasking saves time', 'You need the perfect app', 'Motivation comes before action'],
    quickWins: ['pick tomorrow’s top three tonight', 'block a 90-minute focus session every morning', 'turn off non-human notifications', 'do a 10-minute Friday review'],
    hashtags: ['#productivity', '#notiontemplate', '#timemanagement', '#studygram', '#adhdtips', '#habits', '#planwithme', '#deepwork'],
    icon: 'layers',
    palettes: [['#2B2D42', '#14151F', '#EF233C'], ['#4361EE', '#1B1F4B', '#4CC9F0'], ['#606C38', '#283618', '#DDA15E']],
    nameRoots: ['Focus', 'Clarity', 'Compass', 'Orbit', 'Atlas', 'Sprint', 'Anchor', 'Flow', 'Northstar', 'Cadence'],
    categories: ['Notion Life OS', 'ADHD-Friendly Planning', 'Student Study Systems', 'Weekly Review Routine', 'Freelancer Client Dashboard', 'Habit Tracking'],
    demand: 0.85,
    competition: 0.8,
    priceMult: 0.9,
    calc: 'time',
  },
  {
    id: 'education',
    label: 'Education & Teaching',
    match: ['teacher', 'teachers', 'teaching', 'tutoring', 'tutor', 'classroom', 'homeschool', 'homeschooling', 'study', 'exam', 'students', 'language learning', 'esl', 'learning', 'lesson plan', 'curriculum', 'sat', 'test prep', 'reading', 'math', 'spanish', 'french'],
    audiences: ['K-12 teachers', 'homeschooling parents', 'private tutors', 'adult language learners', 'test-prep students'],
    pains: ['Sunday nights lost to lesson planning', 'students who disengage after ten minutes', 'reinventing worksheets every term', 'test anxiety that tanks scores', 'grading piles that never shrink'],
    desires: ['engaged, curious students', 'planning done in an hour', 'measurable progress every week', 'more evenings back'],
    outcomes: ['plan a full unit in 60 minutes', 'raise test scores by a letter grade', 'cut grading time in half', 'hold a 15-minute conversation in a new language in 90 days'],
    terms: ['lesson plans', 'formative assessment', 'differentiation', 'spaced repetition', 'rubrics', 'learning objectives', 'exit tickets'],
    objections: ['My students are all at different levels', "I don't have budget for resources", "There's no time to try new methods", "Online learning doesn't stick"],
    mistakes: ['lecturing for the whole period', 'assessing only at the end of a unit', 'one-size-fits-all worksheets', 'memorizing without retrieval practice'],
    myths: ['Some people just aren’t good at math', 'Highlighting is effective studying', 'Kids need hours of homework', 'Learning styles should dictate lessons'],
    quickWins: ['start class with a 3-minute retrieval quiz', 'use exit tickets to plan tomorrow', 'batch-create a reusable rubric', 'swap one lecture for a think-pair-share'],
    hashtags: ['#teachersofinstagram', '#homeschool', '#teachertips', '#edtech', '#studytips', '#tutoring', '#languagelearning'],
    icon: 'graduation-cap',
    palettes: [['#F4A261', '#264653', '#2A9D8F'], ['#5E60CE', '#1F1F5C', '#64DFDF'], ['#D62828', '#003049', '#FCBF49']],
    nameRoots: ['Bright', 'Chalk', 'Scholar', 'Spark', 'Quill', 'Lumen', 'Kinder', 'Atlas', 'Inkwell', 'Pathway'],
    categories: ['Lesson Plan Templates', 'Homeschool Curriculum', 'SAT Test Prep', 'Spanish for Beginners', 'Classroom Management', 'Reading Intervention'],
    demand: 0.8,
    competition: 0.7,
    priceMult: 0.85,
    calc: 'grade',
  },
  {
    id: 'parenting',
    label: 'Parenting & Family',
    match: ['parenting', 'parent', 'parents', 'mom', 'moms', 'dad', 'dads', 'baby', 'babies', 'toddler', 'kids', 'family', 'pregnancy', 'newborn', 'sleep training', 'motherhood', 'fatherhood', 'potty training', 'teen', 'teens'],
    audiences: ['new parents', 'working moms', 'dads of toddlers', 'parents of teens', 'expecting couples'],
    pains: ['bedtime battles that last an hour', 'a mental load nobody else sees', 'meltdowns in public', 'guilt about screen time', 'zero time for yourself'],
    desires: ['calm, predictable routines', 'a fair split of the mental load', 'kids who cooperate without yelling', 'an evening that feels like yours again'],
    outcomes: ['cut bedtime to 20 minutes', 'a weekly family plan that takes 15 minutes', 'fewer meltdowns within two weeks', 'reclaim one hour a day for yourself'],
    terms: ['routines', 'gentle parenting', 'visual schedules', 'sleep windows', 'mental load', 'connection time', 'co-parenting'],
    objections: ['Every child is different', "I don't have time to read parenting books", "We've tried sticker charts", "My partner won't get on board"],
    mistakes: ['changing routines every few days', 'explaining rules in the middle of a meltdown', 'doing everything yourself instead of delegating', 'skipping connection time on busy days'],
    myths: ['Good parents never lose their temper', 'Babies should sleep through the night by three months', 'Consistency means being rigid', 'Screen time is always harmful'],
    quickWins: ['post a visual bedtime chart tonight', 'give two choices instead of one command', 'share the grocery list with your partner', 'schedule ten minutes of one-on-one play'],
    hashtags: ['#parentingtips', '#momlife', '#dadlife', '#toddlerlife', '#gentleparenting', '#newmom', '#familyroutine'],
    icon: 'baby',
    palettes: [['#F28482', '#355070', '#F6BD60'], ['#84A59D', '#2F3E46', '#F5CAC3'], ['#E07A5F', '#3D405B', '#F2CC8F']],
    nameRoots: ['Nest', 'Little', 'Cradle', 'Harbor', 'Kin', 'Willow', 'Hatch', 'Sprout', 'Hearth', 'Pebble'],
    categories: ['Toddler Sleep Routines', 'Postpartum Recovery', 'Family Meal Planning', 'Screen Time Balance', 'Potty Training', 'Parenting Teens'],
    demand: 0.84,
    competition: 0.76,
    priceMult: 0.85,
    calc: 'time',
  },
  {
    id: 'food',
    label: 'Food & Cooking',
    match: ['cooking', 'recipe', 'recipes', 'baking', 'meal prep', 'food', 'kitchen', 'chef', 'sourdough', 'bbq', 'grilling', 'plant-based', 'vegetarian', 'dessert', 'cake', 'home cook', 'cookbook'],
    audiences: ['busy home cooks', 'new bakers', 'plant-based families', 'grill enthusiasts', 'college students'],
    pains: ['the nightly "what’s for dinner" panic', 'recipes that flop on the first try', 'grocery bills that keep climbing', 'wasting food every week', 'weeknight cooking that takes too long'],
    desires: ['dinner on the table in 30 minutes', 'bakery-level results at home', 'a fridge with zero waste', 'cooking that feels fun again'],
    outcomes: ['cook five dinners from one grocery list', 'bake your first perfect sourdough loaf', 'cut grocery spending by $200 a month', 'prep a week of lunches in 90 minutes'],
    terms: ['mise en place', 'batch cooking', 'pantry staples', 'hydration ratio', 'sheet-pan meals', 'flavor balance'],
    objections: ["I'm not a good cook", "I don't have fancy equipment", 'My kids are picky', 'Healthy recipes take too long'],
    mistakes: ['shopping without a plan', 'overcrowding the pan', 'skipping salt in early steps', 'following recipes without reading them through first'],
    myths: ['Good cooking needs expensive tools', 'Searing seals in juices', 'Baking is too precise for beginners', 'Frozen vegetables are less nutritious'],
    quickWins: ['plan meals around three base ingredients', 'prep aromatics once for the week', 'use a $15 kitchen scale for baking', 'keep a five-item emergency pantry dinner'],
    hashtags: ['#homecooking', '#mealprep', '#easyrecipes', '#sourdough', '#foodie', '#weeknightdinner', '#bakingfromscratch'],
    icon: 'utensils',
    palettes: [['#D1495B', '#2E1F27', '#EDAE49'], ['#606C38', '#283618', '#FEFAE0'], ['#E76F51', '#264653', '#F4A261']],
    nameRoots: ['Skillet', 'Pantry', 'Crumb', 'Basil', 'Ember', 'Simmer', 'Larder', 'Saffron', 'Hearth', 'Ladle'],
    categories: ['Sourdough for Beginners', '30-Minute Family Dinners', 'Budget Meal Prep', 'Plant-Based Cooking', 'Grilling & BBQ', 'Holiday Baking'],
    demand: 0.82,
    competition: 0.8,
    priceMult: 0.8,
    calc: 'recipe',
  },
  {
    id: 'beauty',
    label: 'Beauty & Self-Care',
    match: ['beauty', 'skincare', 'skin care', 'makeup', 'hair', 'haircare', 'nails', 'nail', 'esthetician', 'lashes', 'lash', 'brows', 'self-care', 'acne', 'anti-aging', 'cosmetics', 'salon', 'barber', 'barbershop', 'spa', 'med spa'],
    audiences: ['skincare beginners', 'busy professionals', 'new estheticians', 'curly-haired women', 'men starting a grooming routine'],
    pains: ['a cabinet full of products that don’t work', 'breakouts that come back every month', 'a 20-step routine nobody has time for', 'confusing ingredient labels', 'salon results that fade in a week'],
    desires: ['clear, calm skin', 'a 5-minute routine that works', 'confidence without heavy makeup', 'products chosen for your skin type'],
    outcomes: ['a 3-step routine you can keep', 'calmer skin in 28 days', 'spending 40% less on products', 'salon-fresh hair between visits'],
    terms: ['skin barrier', 'actives', 'SPF', 'retinol', 'hydration', 'skin cycling', 'patch test'],
    objections: ["I've tried everything already", 'Good skincare is too expensive', "I don't have time for a routine", 'My skin is too sensitive'],
    mistakes: ['layering too many actives at once', 'skipping SPF on cloudy days', 'changing products every week', 'over-exfoliating'],
    myths: ['Oily skin doesn’t need moisturizer', 'Higher price means better results', 'You can shrink pores permanently', 'Natural always means gentler'],
    quickWins: ['simplify to cleanser, moisturizer and SPF for two weeks', 'patch test new products behind the ear', 'set a phone reminder to reapply SPF', 'swap hot showers for lukewarm water'],
    hashtags: ['#skincareroutine', '#skincaretips', '#beautytips', '#selfcare', '#cleanbeauty', '#esthetician', '#glowingskin'],
    icon: 'sparkles',
    palettes: [['#B5838D', '#3E2C33', '#FFCDB2'], ['#8E7DBE', '#2D2545', '#F2C6DE'], ['#C9184A', '#3A0D1C', '#FFB3C1']],
    nameRoots: ['Glow', 'Velvet', 'Bloom', 'Luma', 'Dew', 'Silk', 'Petal', 'Aura', 'Halo', 'Rosewater'],
    categories: ['Skincare for Beginners', 'Acne-Prone Skin Routines', 'Curly Hair Care', 'Esthetician Business', 'Men’s Grooming', 'Clean Makeup'],
    demand: 0.86,
    competition: 0.84,
    priceMult: 0.9,
    calc: 'routine',
  },
  {
    id: 'home',
    label: 'Home & Garden',
    match: ['home', 'garden', 'gardening', 'interior', 'interior design', 'decor', 'cleaning', 'organizing', 'diy', 'renovation', 'plants', 'houseplants', 'landscaping', 'declutter', 'decluttering', 'minimalism', 'home improvement'],
    audiences: ['first-time homeowners', 'renters', 'busy families', 'new gardeners', 'apartment dwellers'],
    pains: ['clutter that comes back every weekend', 'renovation budgets that double', 'plants that die within a month', 'rooms that feel unfinished', 'cleaning that eats the whole Saturday'],
    desires: ['a calm, finished-looking home', 'a garden that feeds the family', 'weekends free from chores', 'projects done on budget'],
    outcomes: ['declutter a room in one weekend', 'keep the house tidy in 20 minutes a day', 'grow your first harvest in 60 days', 'finish a room makeover under $500'],
    terms: ['zones', 'cleaning rotation', 'planting calendar', 'companion planting', 'mood board', 'budget tracker', 'punch list'],
    objections: ['My house is too far gone', 'Renovations always go over budget', 'I have a black thumb', "We don't have time to keep up"],
    mistakes: ['buying storage before decluttering', 'starting too many projects at once', 'overwatering new plants', 'skipping a written budget'],
    myths: ['Organizing means buying more bins', 'You need a big yard to garden', 'DIY always saves money', 'Clean homes need hours every day'],
    quickWins: ['clear one surface and keep it clear for 7 days', 'set a 15-minute daily reset timer', 'start herbs on a sunny windowsill', 'photograph rooms before you redesign them'],
    hashtags: ['#homeorganization', '#declutter', '#gardening', '#interiordesign', '#diyhome', '#cleaningtips', '#homedecor'],
    icon: 'sprout',
    palettes: [['#588157', '#344E41', '#DAD7CD'], ['#BC6C25', '#283618', '#FEFAE0'], ['#577590', '#1D2D44', '#F9C74F']],
    nameRoots: ['Hearth', 'Nook', 'Fern', 'Gable', 'Tidy', 'Burrow', 'Meadow', 'Linden', 'Haven', 'Porch'],
    categories: ['Decluttering Systems', 'Small-Space Gardening', 'Budget Room Makeovers', 'Weekly Cleaning Routines', 'Houseplant Care', 'First Home Checklist'],
    demand: 0.8,
    competition: 0.72,
    priceMult: 0.85,
    calc: 'budget',
  },
  {
    id: 'pets',
    label: 'Pets',
    match: ['pet', 'pets', 'dog', 'dogs', 'cat', 'cats', 'puppy', 'puppies', 'kitten', 'grooming', 'pet sitting', 'dog training', 'vet', 'dog walking', 'pet care', 'groomer'],
    audiences: ['new puppy owners', 'rescue dog adopters', 'busy cat parents', 'first-time dog owners', 'dog walkers starting a business'],
    pains: ['pulling on the leash every walk', 'separation anxiety and chewed furniture', 'vet bills that come out of nowhere', 'a cat that ignores the litter box', 'jumping on every guest'],
    desires: ['a calm, well-mannered dog', 'a happy, healthy pet', 'walks you both enjoy', 'confidence leaving your pet alone'],
    outcomes: ['loose-leash walking in 14 days', 'less separation anxiety in 3 weeks', 'a pet budget with no surprises', 'five core cues in a month'],
    terms: ['positive reinforcement', 'crate training', 'enrichment', 'recall', 'socialization window', 'routine'],
    objections: ['My dog is too old to learn', 'Trainers are too expensive', "I don't have time for daily training", 'My pet is just stubborn'],
    mistakes: ['repeating cues over and over', 'punishing after the fact', 'skipping mental enrichment', 'inconsistent rules between family members'],
    myths: ['Old dogs can’t learn new tricks', 'Cats can’t be trained', 'A tired dog is always a good dog', 'Dominance training is necessary'],
    quickWins: ['practice 3 five-minute sessions a day', 'use a snuffle mat at dinner', 'reward calm behavior at the door', 'set one family-wide cue list'],
    hashtags: ['#dogtraining', '#puppytraining', '#dogsofinstagram', '#catsofinstagram', '#rescuedog', '#pettips', '#doglife'],
    icon: 'paw-print',
    palettes: [['#E76F51', '#2A2A2A', '#F4A261'], ['#457B9D', '#1D3557', '#F1C453'], ['#6D597A', '#355070', '#EAAC8B']],
    nameRoots: ['Paw', 'Wag', 'Biscuit', 'Tails', 'Fetch', 'Whisker', 'Pack', 'Snout', 'Collar', 'Pounce'],
    categories: ['Puppy Training', 'Separation Anxiety', 'Cat Behavior', 'Dog Walking Business', 'Pet Nutrition', 'Rescue Dog Adoption'],
    demand: 0.83,
    competition: 0.7,
    priceMult: 0.85,
    calc: 'budget',
  },
  {
    id: 'creative',
    label: 'Design & Creative',
    match: ['design', 'graphic design', 'photography', 'photographer', 'photo', 'illustration', 'canva', 'figma', 'art', 'artist', 'procreate', 'video editing', 'lightroom', 'music production', 'podcast', 'podcasting', 'ui design', 'ux', 'web design', 'logo', 'presets'],
    audiences: ['freelance designers', 'hobby photographers', 'small brands doing their own design', 'new podcasters', 'digital illustrators'],
    pains: ['undercharging for creative work', 'clients who request endless revisions', 'a portfolio that doesn’t attract the right clients', 'hours lost recreating the same assets', 'editing that takes longer than shooting'],
    desires: ['premium clients and premium rates', 'a signature style', 'workflows that save hours', 'work that gets noticed'],
    outcomes: ['raise your rates by 30%', 'cut editing time in half', 'land three dream clients', 'ship a brand kit in 48 hours'],
    terms: ['presets', 'brand kit', 'mockups', 'color grading', 'style guide', 'revision rounds', 'licensing'],
    objections: ['The market is saturated', 'AI will replace designers', 'Templates feel generic', "I'm not ready to charge more"],
    mistakes: ['offering unlimited revisions', 'showing every project in the portfolio', 'skipping a written creative brief', 'editing every photo from scratch'],
    myths: ['You need expensive gear', 'Talent matters more than process', 'Templates kill creativity', 'Good work markets itself'],
    quickWins: ['cap revisions at two rounds in your contract', 'save your best edit as a preset', 'cut your portfolio to your eight strongest pieces', 'send a creative brief before every project'],
    hashtags: ['#graphicdesign', '#photography', '#designtips', '#creativebusiness', '#canvatemplates', '#illustration', '#lightroompresets'],
    icon: 'palette',
    palettes: [['#FF6B6B', '#1A1A2E', '#FFD93D'], ['#2EC4B6', '#011627', '#FF9F1C'], ['#8338EC', '#1B0A3C', '#FFBE0B']],
    nameRoots: ['Studio', 'Pixel', 'Canvas', 'Prism', 'Hue', 'Frame', 'Ink', 'Grain', 'Palette', 'Aperture'],
    categories: ['Lightroom Presets', 'Canva Social Templates', 'Freelance Design Pricing', 'Brand Kit Design', 'Podcast Launch', 'Procreate Brushes'],
    demand: 0.84,
    competition: 0.82,
    priceMult: 1,
    calc: 'pricing',
  },
  {
    id: 'career',
    label: 'Career & Coaching',
    match: ['career', 'resume', 'cv', 'interview', 'job', 'job search', 'linkedin', 'promotion', 'salary', 'negotiation', 'coaching', 'coach', 'leadership', 'manager', 'managers', 'career change', 'public speaking', 'executive'],
    audiences: ['career changers', 'new managers', 'recent graduates', 'mid-career professionals', 'aspiring coaches'],
    pains: ['applications that vanish into a black hole', 'interviews that go well but end in silence', 'being underpaid and not knowing it', 'managing people with zero training', 'feeling stuck in the wrong career'],
    desires: ['offers from roles you actually want', 'a raise you negotiated with confidence', 'a team that trusts you', 'a clear next career move'],
    outcomes: ['land interviews within 30 days', 'negotiate a 10–20% higher offer', 'run effective one-on-ones from week one', 'switch careers in 6 months'],
    terms: ['ATS', 'STAR stories', 'salary bands', 'informational interviews', 'one-on-ones', 'career capital', 'personal brand'],
    objections: ['The job market is too competitive', "I don't have the right experience", 'Negotiating feels awkward', "I'm too old to switch careers"],
    mistakes: ['sending the same resume to every job', 'listing duties instead of results', 'accepting the first offer', 'skipping follow-up notes'],
    myths: ['Recruiters read every word', 'You must have every listed requirement', 'Asking for more risks the offer', 'Networking means asking for jobs'],
    quickWins: ['rewrite three bullets as measurable wins', 'prepare five STAR stories', 'research the salary band before the call', 'send one informational interview request today'],
    hashtags: ['#careertips', '#jobsearch', '#resumetips', '#interviewtips', '#leadership', '#careerchange', '#salarynegotiation'],
    icon: 'briefcase',
    palettes: [['#003F88', '#00171F', '#FDC500'], ['#2B9348', '#1B4332', '#EEEF20'], ['#6930C3', '#240046', '#80FFDB']],
    nameRoots: ['Ladder', 'Summit', 'Pivot', 'Elevate', 'Compass', 'Ascend', 'Launch', 'Keystone', 'Merit', 'Bridge'],
    categories: ['Resume Rewrite', 'Interview Prep', 'Salary Negotiation', 'First-Time Manager', 'Career Change', 'LinkedIn Profile Optimization'],
    demand: 0.84,
    competition: 0.76,
    priceMult: 1.3,
    calc: 'salary',
  },
  {
    id: 'ecommerce',
    label: 'E-commerce & Retail',
    match: ['ecommerce', 'e-commerce', 'shopify', 'etsy', 'amazon', 'dropshipping', 'print on demand', 'online store', 'retail', 'product photography', 'boutique', 'merch', 'wholesale', 'amazon fba', 'handmade'],
    audiences: ['Etsy sellers', 'new Shopify store owners', 'handmade makers', 'boutique owners', 'print-on-demand beginners'],
    pains: ['traffic that never converts', 'abandoned carts piling up', 'thin margins after fees and shipping', 'product photos that look amateur', 'listings buried on page ten'],
    desires: ['a steady stream of orders', 'repeat customers', 'healthy margins', 'listings that rank'],
    outcomes: ['lift conversion rate by a full point', 'recover 15% of abandoned carts', 'price products for a 60% margin', 'rank on page one for three keywords'],
    terms: ['conversion rate', 'AOV', 'abandoned cart flow', 'listing SEO', 'margins', 'fulfillment', 'LTV'],
    objections: ['The market is saturated', 'Ads are too expensive', "I can't compete with Amazon", "I'm not a photographer"],
    mistakes: ['pricing by gut instead of costing every component', 'driving traffic before fixing the product page', 'ignoring email for repeat sales', 'using supplier photos'],
    myths: ['More products means more sales', 'You need paid ads to start', 'Free shipping kills margins', 'Etsy SEO is just tags'],
    quickWins: ['add a 3-email abandoned cart flow', 'rewrite product titles with buyer keywords', 'shoot photos by a window with a white foam board', 'bundle two best-sellers to raise AOV'],
    hashtags: ['#etsyseller', '#shopify', '#ecommerce', '#smallbusinessowner', '#handmade', '#printondemand', '#onlinebusiness'],
    icon: 'shopping-bag',
    palettes: [['#F15BB5', '#2C0735', '#FEE440'], ['#00BBF9', '#03045E', '#FEE440'], ['#FF6F59', '#254441', '#43AA8B']],
    nameRoots: ['Cart', 'Crate', 'Shelf', 'Parcel', 'Market', 'Bazaar', 'Stockroom', 'Merchant', 'Dock', 'Tag'],
    categories: ['Etsy SEO', 'Shopify Store Launch', 'Product Photography', 'Abandoned Cart Recovery', 'Pricing for Profit', 'Print on Demand'],
    demand: 0.85,
    competition: 0.83,
    priceMult: 1.1,
    calc: 'margin',
  },
  {
    id: 'mindfulness',
    label: 'Mindfulness & Mental Wellness',
    match: ['mindfulness', 'meditation', 'anxiety', 'stress', 'therapy', 'journaling', 'journal', 'self care', 'burnout', 'mental health', 'spiritual', 'spirituality', 'breathwork', 'gratitude', 'confidence', 'self-esteem', 'calm'],
    audiences: ['overwhelmed professionals', 'new meditators', 'burned-out caregivers', 'students under pressure', 'highly sensitive people'],
    pains: ['racing thoughts at 2 a.m.', 'burnout that weekends don’t fix', 'meditation apps abandoned after a week', 'saying yes to everything', 'anxiety before every big moment'],
    desires: ['a calmer nervous system', 'steady, restful sleep', 'boundaries without guilt', 'a daily practice that sticks'],
    outcomes: ['a 10-minute daily practice you keep', 'falling asleep without scrolling', 'lower stress in 21 days', 'handling hard conversations calmly'],
    terms: ['breathwork', 'journaling prompts', 'nervous system', 'boundaries', 'body scan', 'gratitude practice', 'reflection'],
    objections: ["I can't quiet my mind", "I don't have time to meditate", 'Journaling feels awkward', "I've tried apps and quit"],
    mistakes: ['trying to empty the mind', 'practicing only when already overwhelmed', 'starting with 30-minute sessions', 'journaling without prompts'],
    myths: ['Meditation means thinking about nothing', 'Self-care is selfish', 'You need an hour of quiet', 'Stress is always bad'],
    quickWins: ['try a 4-7-8 breath before bed tonight', 'write three lines each morning', 'set one no-phone hour', 'name the feeling to tame it'],
    hashtags: ['#mindfulness', '#selfcare', '#mentalhealthmatters', '#meditation', '#journaling', '#burnoutrecovery', '#breathwork'],
    icon: 'flower-2',
    palettes: [['#7D8CC4', '#2E3150', '#F2D0A9'], ['#8AB17D', '#2A4747', '#E9C46A'], ['#B388EB', '#2F1847', '#F7AEF8']],
    nameRoots: ['Still', 'Calm', 'Lumen', 'Haven', 'Breathe', 'Tide', 'Ember', 'Solace', 'Grove', 'Kindred'],
    categories: ['Burnout Recovery', 'Journaling for Anxiety', 'Meditation for Beginners', 'Sleep & Wind-Down', 'Boundaries at Work', 'Confidence Building'],
    demand: 0.83,
    competition: 0.74,
    priceMult: 0.85,
    calc: 'habit',
  },
  {
    id: 'tech',
    label: 'Tech, AI & No-Code',
    match: ['coding', 'developer', 'developers', 'programming', 'ai', 'artificial intelligence', 'automation', 'no-code', 'nocode', 'python', 'javascript', 'data', 'web development', 'chatgpt', 'prompt', 'prompts', 'excel', 'spreadsheet', 'zapier', 'api', 'machine learning', 'sql', 'app'],
    audiences: ['non-technical founders', 'junior developers', 'operations managers', 'solo creators automating work', 'analysts learning Python'],
    pains: ['repetitive tasks eating 10 hours a week', 'tutorials that never become real projects', 'tools that do not talk to each other', 'AI outputs that miss the mark', 'spreadsheets that break every month'],
    desires: ['workflows that run themselves', 'shipping real projects', 'AI that actually helps', 'skills employers pay for'],
    outcomes: ['automate 5 hours of busywork a week', 'ship your first app in 30 days', 'write prompts that get usable output first try', 'build a reporting dashboard in a weekend'],
    terms: ['automation', 'API', 'prompt templates', 'workflow', 'dashboard', 'scripts', 'integrations'],
    objections: ["I'm not technical", 'Learning to code takes years', 'AI tools change too fast', 'Automation tools are expensive'],
    mistakes: ['automating a broken process', 'learning syntax without building projects', 'vague one-line prompts', 'copying code you do not understand'],
    myths: ['You need a CS degree', 'AI will do the thinking for you', 'No-code can’t scale', 'More tools means more productivity'],
    quickWins: ['list three tasks you repeat weekly', 'save your best prompt as a template', 'connect two apps with one automation', 'build one tiny project this weekend'],
    hashtags: ['#nocode', '#automation', '#aitools', '#learntocode', '#chatgpt', '#productivitytools', '#python'],
    icon: 'laptop',
    palettes: [['#7209B7', '#10002B', '#4CC9F0'], ['#06D6A0', '#073B4C', '#FFD166'], ['#3A86FF', '#0B132B', '#FFBE0B']],
    nameRoots: ['Stack', 'Script', 'Logic', 'Circuit', 'Byte', 'Relay', 'Kernel', 'Syntax', 'Node', 'Forge'],
    categories: ['AI Prompt Libraries', 'No-Code Automation', 'Python for Analysts', 'Excel Dashboards', 'Build Your First App', 'ChatGPT for Small Business'],
    demand: 0.9,
    competition: 0.78,
    priceMult: 1.2,
    calc: 'roi',
  },
  {
    id: 'travel',
    label: 'Travel',
    match: ['travel', 'backpacking', 'digital nomad', 'vacation', 'trip', 'trips', 'tourism', 'itinerary', 'road trip', 'points', 'travel hacking', 'solo travel', 'van life'],
    audiences: ['first-time solo travelers', 'families on a budget', 'remote workers going nomad', 'points and miles beginners', 'road trippers'],
    pains: ['planning that takes weeks of tabs', 'overpaying for flights and hotels', 'tourist traps instead of real experiences', 'burnout from packed itineraries', 'work and travel colliding'],
    desires: ['trips that feel effortless', 'more trips for the same budget', 'local, memorable experiences', 'working from anywhere'],
    outcomes: ['plan a trip in one evening', 'save $500 per trip', 'earn a free flight in 90 days', 'a balanced 7-day itinerary'],
    terms: ['itinerary', 'points and miles', 'shoulder season', 'carry-on only', 'travel insurance', 'layovers'],
    objections: ['Travel is too expensive', "I don't have time to plan", 'Traveling solo feels unsafe', 'Kids make travel impossible'],
    mistakes: ['booking flights before checking flexible dates', 'overpacking', 'cramming three cities into five days', 'skipping travel insurance'],
    myths: ['Last-minute deals are always cheapest', 'Points are only for frequent flyers', 'Travel with kids is not worth it', 'Nomads are always on vacation'],
    quickWins: ['set fare alerts for your dream route', 'pack carry-on only for your next trip', 'choose one anchor activity per day', 'open a no-fee travel card'],
    hashtags: ['#traveltips', '#digitalnomad', '#solotravel', '#budgettravel', '#travelhacks', '#familytravel', '#wanderlust'],
    icon: 'plane',
    palettes: [['#0077B6', '#03045E', '#FFB703'], ['#F77F00', '#003049', '#FCBF49'], ['#2A9D8F', '#264653', '#E76F51']],
    nameRoots: ['Wander', 'Compass', 'Passport', 'Voyage', 'Atlas', 'Nomad', 'Drift', 'Horizon', 'Trail', 'Roam'],
    categories: ['Travel Itinerary Templates', 'Points & Miles for Beginners', 'Family Travel on a Budget', 'Digital Nomad Setup', 'Solo Travel Safety', 'Road Trip Planning'],
    demand: 0.78,
    competition: 0.75,
    priceMult: 0.85,
    calc: 'budget',
  },
  {
    id: 'home-services',
    label: 'Home Services',
    local: true,
    match: ['plumbing', 'plumber', 'hvac', 'electrician', 'electrical', 'roofing', 'roofer', 'cleaning service', 'house cleaning', 'home cleaning', 'cleaning company', 'maid', 'cleaners', 'cleaning', 'handyman', 'landscaping company', 'lawn care', 'lawn', 'pest control', 'moving company', 'movers', 'painting', 'painter', 'contractor', 'remodeling', 'pressure washing', 'window cleaning', 'pool service', 'junk removal', 'carpet cleaning'],
    audiences: ['homeowners', 'busy families', 'property managers', 'new homeowners', 'landlords'],
    pains: ['contractors who never show up', 'surprise charges on the final bill', 'waiting days for a quote', 'emergencies on nights and weekends', 'messy job sites left behind'],
    desires: ['on-time, tidy professionals', 'upfront, fair pricing', 'one trusted company to call', 'problems fixed right the first time'],
    outcomes: ['same-week appointments', 'a written quote within 24 hours', 'a spotless home every other week', 'no-surprise pricing'],
    terms: ['free estimate', 'licensed and insured', 'service area', 'maintenance plan', 'same-day service', 'warranty'],
    objections: ['Your prices are higher than the other guy', "I'll try to fix it myself", 'I had a bad experience with a contractor', 'Can I trust strangers in my home?'],
    mistakes: ['ignoring small leaks until they are big', 'choosing the cheapest quote without checking insurance', 'skipping seasonal maintenance', 'paying the full amount upfront'],
    myths: ['DIY always saves money', 'All contractors are the same', 'Maintenance plans are an upsell', 'Bigger companies do better work'],
    quickWins: ['test your sump pump before the rainy season', 'change HVAC filters every 90 days', 'book cleanings on a recurring schedule', 'ask for photo updates on every job'],
    hashtags: ['#homeservices', '#smallbusiness', '#homeimprovement', '#cleaningservice', '#hvac', '#plumbing', '#localbusiness', '#supportlocal'],
    icon: 'wrench',
    palettes: [['#1D4ED8', '#0B1D4D', '#F59E0B'], ['#047857', '#022C22', '#FBBF24'], ['#DC2626', '#1F2937', '#F3F4F6']],
    nameRoots: ['Reliable', 'Summit', 'Prime', 'True', 'Northside', 'Ironwood', 'Clearview', 'Patriot', 'Evergreen', 'Keystone'],
    categories: ['Residential Cleaning', 'HVAC Repair', 'Plumbing Services', 'Lawn Care & Landscaping', 'Handyman Services', 'Pressure Washing'],
    demand: 0.88,
    competition: 0.7,
    priceMult: 1.2,
    calc: 'quote',
  },
  {
    id: 'food-business',
    label: 'Restaurants & Cafés',
    local: true,
    match: ['restaurant', 'cafe', 'café', 'coffee shop', 'coffee', 'bakery', 'food truck', 'catering', 'bar', 'brewery', 'pizzeria', 'pizza', 'taqueria', 'bistro', 'juice bar', 'ice cream', 'donut', 'tea shop', 'deli', 'ghost kitchen', 'diner', 'roaster'],
    audiences: ['local foodies', 'families on weeknights', 'office lunch crowds', 'event planners', 'weekend brunch regulars'],
    pains: ['slow weeknights that eat into margins', 'third-party delivery fees', 'empty tables between rushes', 'one-time visitors who never return', 'reviews that sink with one bad night'],
    desires: ['a packed dining room on weeknights', 'loyal regulars', 'more direct online orders', 'catering revenue that smooths slow months'],
    outcomes: ['fill 20% more tables on Tuesday nights', 'grow direct orders and skip delivery fees', 'turn first-timers into monthly regulars', 'book three catering events a month'],
    terms: ['covers', 'ticket average', 'loyalty program', 'prep list', 'seasonal menu', 'catering packages', 'food cost'],
    objections: ["We're too busy to market", 'Delivery apps already bring customers', 'Our food speaks for itself', 'Marketing never brings real foot traffic'],
    mistakes: ['relying only on delivery apps', 'posting food photos without people or story', 'ignoring negative reviews', 'running discounts without a goal'],
    myths: ['Great food guarantees full tables', 'Discounts build loyalty', 'Instagram alone fills seats', 'Catering is only for big kitchens'],
    quickWins: ['reply to every review this week', 'launch a Tuesday-only special', 'add a direct ordering link to your bio', 'feature a staff member behind the counter'],
    hashtags: ['#localeats', '#foodie', '#supportlocal', '#coffeeshop', '#bakery', '#brunch', '#smallbusiness', '#eatlocal'],
    icon: 'coffee',
    palettes: [['#9C2C2C', '#2B1A12', '#F2C14E'], ['#3D405B', '#1E1E2E', '#F2CC8F'], ['#2D6A4F', '#1B2E24', '#F4A261']],
    nameRoots: ['Ember', 'Copper', 'Crumb', 'Hearth', 'Saffron', 'Mill', 'Corner', 'Olive', 'Brew', 'Larder'],
    categories: ['Neighborhood Café', 'Artisan Bakery', 'Food Truck', 'Catering Company', 'Family Restaurant', 'Craft Coffee Roaster'],
    demand: 0.86,
    competition: 0.78,
    priceMult: 1,
    calc: 'food-cost',
  },
  {
    id: 'professional-services',
    label: 'Professional Services',
    local: true,
    match: ['accounting firm', 'accountant', 'cpa', 'bookkeeper', 'law firm', 'lawyer', 'attorney', 'consultant', 'consulting', 'agency', 'marketing agency', 'insurance', 'financial advisor', 'tax preparer', 'notary', 'it services', 'web agency', 'virtual assistant', 'staffing'],
    audiences: ['small business owners', 'startups', 'families planning finances', 'local nonprofits', 'self-employed professionals'],
    pains: ['not knowing who to trust with important decisions', 'hourly bills that spiral', 'slow responses when it matters', 'jargon-filled advice', 'one-size-fits-all service'],
    desires: ['a trusted advisor on call', 'clear, fixed pricing', 'fast, plain-English answers', 'peace of mind about compliance'],
    outcomes: ['a response within one business day', 'fixed-fee packages with no surprises', 'quarterly check-ins that prevent problems', 'hours saved every month'],
    terms: ['retainer', 'discovery call', 'scope of work', 'compliance', 'deliverables', 'client portal'],
    objections: ["You're too expensive", 'I can handle it myself', 'We already have someone', "I don't know what I need yet"],
    mistakes: ['waiting until a crisis to get advice', 'choosing on price alone', 'skipping a written scope', 'not reviewing the engagement yearly'],
    myths: ['Professional help is only for big companies', 'Hourly billing is fairer', 'All advisors offer the same thing', 'Software replaces expertise'],
    quickWins: ['book a free 20-minute discovery call', 'gather last year’s documents in one folder', 'write down your top three questions', 'set a quarterly review reminder'],
    hashtags: ['#smallbusinessowner', '#consulting', '#accounting', '#entrepreneur', '#businessadvice', '#localbusiness', '#professionalservices'],
    icon: 'building-2',
    palettes: [['#1E3A8A', '#0F172A', '#D4AF37'], ['#334155', '#0F172A', '#38BDF8'], ['#14532D', '#052E16', '#FCD34D']],
    nameRoots: ['Sterling', 'Meridian', 'Keystone', 'Ledger', 'Beacon', 'Harbor', 'Atlas', 'Pinnacle', 'Clarity', 'Bridgewell'],
    categories: ['Bookkeeping Firm', 'Marketing Agency', 'IT Support', 'Legal Services', 'Insurance Agency', 'Business Consulting'],
    demand: 0.8,
    competition: 0.68,
    priceMult: 1.8,
    calc: 'roi',
  },
  {
    id: 'events',
    label: 'Weddings & Events',
    local: true,
    match: ['wedding', 'weddings', 'event', 'events', 'party', 'parties', 'planner', 'event planning', 'dj', 'florist', 'flowers', 'photo booth', 'venue', 'bridal', 'quinceañera', 'catering events'],
    audiences: ['engaged couples', 'corporate event planners', 'parents planning milestone parties', 'nonprofit fundraisers'],
    pains: ['vendor chaos and missed details', 'budgets that balloon', 'stressful final weeks', 'generic events that feel like everyone else’s'],
    desires: ['a day that feels personal', 'stress-free planning', 'a budget that holds', 'guests who talk about it for years'],
    outcomes: ['a complete plan 90 days out', 'staying within budget by 5%', 'a single point of contact for every vendor'],
    terms: ['timeline', 'run of show', 'vendor list', 'day-of coordination', 'mood board', 'RSVPs'],
    objections: ['Planners are a luxury', 'We can do it ourselves', 'Our budget is too small', "We're not sure about our date yet"],
    mistakes: ['booking vendors before setting the budget', 'skipping a day-of timeline', 'forgetting a rain plan', 'over-inviting early'],
    myths: ['Planners only work with big budgets', 'DIY weddings are always cheaper', 'Saturday is the only option', 'More decor means more memorable'],
    quickWins: ['set a top-three priorities list together', 'create one shared vendor spreadsheet', 'pick a backup date', 'build the day-of timeline backward from dinner'],
    hashtags: ['#weddingplanning', '#eventplanner', '#bride2be', '#weddinginspo', '#eventdesign', '#florist', '#partyplanning'],
    icon: 'gem',
    palettes: [['#B08968', '#3D2C2E', '#EDE0D4'], ['#9D4EDD', '#240046', '#F3C4FB'], ['#2F3E46', '#1B2421', '#CAD2C5']],
    nameRoots: ['Gilded', 'Velvet', 'Petal', 'Ivory', 'Linen', 'Golden', 'Bloom', 'Soiree', 'Garland', 'Ever'],
    categories: ['Wedding Planning', 'Day-of Coordination', 'Floral Design', 'Corporate Events', 'Event DJ Services', 'Party Rentals'],
    demand: 0.78,
    competition: 0.7,
    priceMult: 1.3,
    calc: 'budget',
  },
  {
    id: 'automotive',
    label: 'Automotive',
    local: true,
    match: ['auto', 'car', 'cars', 'auto repair', 'mechanic', 'detailing', 'car detailing', 'tires', 'oil change', 'body shop', 'auto shop', 'car wash', 'ev charging'],
    audiences: ['commuters', 'families with older cars', 'car enthusiasts', 'fleet managers', 'new drivers'],
    pains: ['not knowing if a repair quote is fair', 'waiting days for a simple fix', 'surprise breakdowns', 'upsells you never asked for'],
    desires: ['a mechanic you can trust', 'quick turnarounds', 'a car that lasts', 'transparent pricing'],
    outcomes: ['same-day oil changes', 'a written quote before any work', 'years of extra life for your car', 'a showroom shine in one visit'],
    terms: ['diagnostics', 'maintenance schedule', 'detailing package', 'warranty', 'OEM parts', 'inspection'],
    objections: ['Dealers are safer', "I'll wait until something breaks", 'Detailing is a luxury', 'Every shop upsells'],
    mistakes: ['skipping scheduled maintenance', 'ignoring warning lights', 'buying the cheapest tires', 'washing with dish soap'],
    myths: ['You must service at the dealer to keep the warranty', 'Premium fuel helps every car', 'Oil changes every 3,000 miles', 'Ceramic coating means never washing'],
    quickWins: ['check tire pressure monthly', 'keep a maintenance log in your glovebox', 'book seasonal inspections', 'vacuum and wipe the interior weekly'],
    hashtags: ['#autorepair', '#cardetailing', '#mechanic', '#carcare', '#supportlocal', '#carsofinstagram', '#autoshop'],
    icon: 'car',
    palettes: [['#E63946', '#1D3557', '#F1FAEE'], ['#FFB703', '#023047', '#8ECAE6'], ['#2B2D42', '#111111', '#EF233C']],
    nameRoots: ['Torque', 'Piston', 'Gearhouse', 'Redline', 'Axle', 'Garage', 'Chrome', 'Throttle', 'Ironclad', 'Motorwerks'],
    categories: ['Auto Repair Shop', 'Mobile Car Detailing', 'Tire & Oil Service', 'EV Maintenance', 'Body & Paint', 'Fleet Services'],
    demand: 0.78,
    competition: 0.7,
    priceMult: 1.2,
    calc: 'quote',
  },
];

export const NICHE_SUGGESTIONS = [
  'Personal Finance',
  'Fitness',
  'B2B SaaS',
  'Real Estate',
  'Health & Nutrition',
  'Marketing',
  'Productivity',
  'Parenting',
  'Beauty & Skincare',
  'Food & Cooking',
  'Pets',
  'Career Coaching',
];

export const BUSINESS_NICHE_SUGGESTIONS = [
  'Home Cleaning',
  'Coffee Shop',
  'Hair Salon',
  'Personal Training',
  'Bakery',
  'Landscaping',
  'Dog Grooming',
  'Bookkeeping',
  'Photography Studio',
  'Auto Detailing',
  'Tutoring',
  'Marketing Agency',
];

// ───────────────────────── Audience extraction ─────────────────────────
const AUDIENCE_PATTERNS: [RegExp, string][] = [
  [/freelanc/i, 'freelancers'],
  [/postpartum|new moms?|new mums?/i, 'new moms'],
  [/\bmoms?\b|mothers?|mums?\b/i, 'busy moms'],
  [/\bdads?\b|fathers?/i, 'dads'],
  [/teacher/i, 'teachers'],
  [/student/i, 'students'],
  [/nurse/i, 'nurses'],
  [/\bcoach(es)?\b/i, 'coaches'],
  [/realtor|real estate agent/i, 'real estate agents'],
  [/founder|startup/i, 'startup founders'],
  [/small business/i, 'small business owners'],
  [/creator/i, 'content creators'],
  [/designer/i, 'designers'],
  [/developer|engineer/i, 'developers'],
  [/writer|author/i, 'writers'],
  [/photographer/i, 'photographers'],
  [/therapist/i, 'therapists'],
  [/runner/i, 'runners'],
  [/beginner/i, 'beginners'],
  [/senior|over 50|over 60|retiree/i, 'adults over 50'],
  [/over 40|40\+/i, 'adults over 40'],
  [/\bwomen\b/i, 'women'],
  [/\bmen\b/i, 'men'],
  [/remote/i, 'remote workers'],
  [/couple/i, 'couples'],
  [/\bhosts?\b|airbnb|short-term rental/i, 'short-term rental hosts'],
  [/landlord/i, 'landlords'],
  [/homebuyer|home buyer|first-time buyer/i, 'first-time homebuyers'],
  [/esthetician/i, 'estheticians'],
  [/etsy|shopify|seller/i, 'online sellers'],
  [/manager/i, 'new managers'],
  [/graduate|grads?\b/i, 'recent graduates'],
  [/toddler|kids|children/i, 'parents of young kids'],
  [/\bteens?\b/i, 'parents of teens'],
  [/dog|puppy|puppies/i, 'dog owners'],
  [/\bcats?\b|kitten/i, 'cat owners'],
  [/adhd/i, 'adults with ADHD'],
  [/nomad/i, 'digital nomads'],
  [/sales team|sdr/i, 'sales teams'],
  [/homeowner/i, 'homeowners'],
  [/bride|wedding|engaged/i, 'engaged couples'],
  [/desk/i, 'desk workers'],
  [/athlete/i, 'athletes'],
  [/vegan|plant-based/i, 'plant-based eaters'],
  [/perimenopause|menopause/i, 'women in perimenopause'],
  [/homeschool/i, 'homeschooling parents'],
  [/agency|agencies/i, 'agency owners'],
  [/nonprofit/i, 'nonprofit leaders'],
];

export function extractAudience(text: string): string | null {
  for (const [re, aud] of AUDIENCE_PATTERNS) if (re.test(text)) return aud;
  return null;
}

export function matchNiche(niche: string, category = '', preferLocal = false): NicheProfile | null {
  const n = ` ${niche.toLowerCase()} `;
  const c = ` ${category.toLowerCase()} `;
  let best: NicheProfile | null = null;
  let bestScore = 0;
  for (const p of NICHES) {
    let score = 0;
    for (const kw of p.match) {
      const re = new RegExp(`[^a-z]${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z]`);
      if (re.test(n)) score += 3 + kw.length / 10;
      if (re.test(c)) score += 2 + kw.length / 12;
    }
    if (p.label.toLowerCase() === niche.trim().toLowerCase()) score += 6;
    if (preferLocal && p.local && score > 0) score *= 1.8;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore > 0 ? best : null;
}

// ───────────────────────── Product formats ─────────────────────────
export interface FormatProfile {
  id: ProductFormat;
  label: string;
  short: string;
  icon: string;
  desc: string;
  nouns: string[];
  unit: string;
  price: [number, number];
  model: PriceModel;
  scalability: number;
  volume: number;
  outlineLabel: string;
}

export const FORMATS: Record<ProductFormat, FormatProfile> = {
  pdf: { id: 'pdf', label: 'PDFs / Guides', short: 'Guide', icon: 'file-text', desc: 'Downloadable guides, playbooks and workbooks', nouns: ['Guide', 'Playbook', 'Blueprint', 'Field Guide', 'Workbook', 'Roadmap'], unit: 'chapters', price: [17, 47], model: 'one-time', scalability: 0.92, volume: 120, outlineLabel: 'Guide chapters' },
  course: { id: 'course', label: 'Online Courses', short: 'Course', icon: 'presentation', desc: 'Video lessons with worksheets and quizzes', nouns: ['Course', 'Masterclass', 'Academy', 'Bootcamp', 'Program', 'Accelerator'], unit: 'modules', price: [97, 397], model: 'one-time', scalability: 0.86, volume: 24, outlineLabel: 'Course curriculum' },
  template: { id: 'template', label: 'Templates', short: 'Templates', icon: 'layout-template', desc: 'Notion, Canva, Docs or Figma templates', nouns: ['Template Kit', 'Template Pack', 'Toolkit', 'System', 'OS', 'Starter Kit'], unit: 'templates', price: [19, 69], model: 'one-time', scalability: 0.95, volume: 90, outlineLabel: 'Templates included' },
  spreadsheet: { id: 'spreadsheet', label: 'Spreadsheets', short: 'Spreadsheet', icon: 'table-2', desc: 'Trackers, calculators and dashboards', nouns: ['Spreadsheet', 'Tracker', 'Dashboard', 'Calculator', 'Planner', 'Workbook'], unit: 'tabs', price: [15, 49], model: 'one-time', scalability: 0.95, volume: 100, outlineLabel: 'Spreadsheet tabs' },
  software: { id: 'software', label: 'Software / Web Apps', short: 'App', icon: 'app-window', desc: 'Micro-SaaS tools and web apps', nouns: ['App', 'Tool', 'Assistant', 'Platform', 'Portal', 'Copilot'], unit: 'features', price: [9, 29], model: 'monthly', scalability: 0.9, volume: 60, outlineLabel: 'Product features (MVP)' },
  design: { id: 'design', label: 'Design Assets', short: 'Asset Pack', icon: 'pen-tool', desc: 'Graphics, icons, mockups and brand kits', nouns: ['Asset Pack', 'Graphics Bundle', 'Brand Kit', 'Icon Set', 'Mockup Pack', 'Canva Kit'], unit: 'packs', price: [19, 79], model: 'one-time', scalability: 0.94, volume: 80, outlineLabel: 'Asset packs' },
  audio: { id: 'audio', label: 'Audio Products', short: 'Audio', icon: 'headphones', desc: 'Guided sessions, sound packs and audio courses', nouns: ['Audio Series', 'Guided Sessions', 'Audio Course', 'Sound Pack', 'Podcast Series', 'Audio Program'], unit: 'tracks', price: [15, 59], model: 'one-time', scalability: 0.9, volume: 70, outlineLabel: 'Audio tracks' },
  membership: { id: 'membership', label: 'Memberships', short: 'Membership', icon: 'crown', desc: 'Recurring community, content and support', nouns: ['Club', 'Membership', 'Circle', 'Collective', 'Inner Circle', 'Community'], unit: 'tiers', price: [9, 39], model: 'monthly', scalability: 0.8, volume: 50, outlineLabel: 'Membership tiers & monthly content' },
  ebook: { id: 'ebook', label: 'Ebooks', short: 'Ebook', icon: 'book-open-text', desc: 'Long-form books for Kindle, PDF or ePub', nouns: ['Ebook', 'Handbook', 'Book', 'Manual', 'Guidebook', 'Field Manual'], unit: 'chapters', price: [9, 29], model: 'one-time', scalability: 0.93, volume: 150, outlineLabel: 'Book chapters' },
};

export const FORMAT_LIST = Object.values(FORMATS);

// ───────────────────────── Business models ─────────────────────────
export interface BusinessType {
  id: string;
  label: string;
  /** word used in brand names, e.g. "Summit Cleaning" */
  noun: string;
  match: string[];
  category: string;
  icon: string;
  services: { name: string; price: [number, number]; unit: ServicePriceModel; duration?: string }[];
  tiers: [string, string, string];
  booking: BookingType;
  hours: string;
  bookingFlow: string[];
  delivery: string[];
  roles: string[];
  tools: string[];
  revenue: string[];
  costs: string[];
  kpis: string[];
  bonuses: string[];
  guarantee: string;
}

export const BUSINESS_TYPES: BusinessType[] = [
  {
    id: 'cleaning',
    label: 'Home Cleaning',
    noun: 'Cleaning',
    match: ['clean', 'cleaning', 'maid', 'janitorial', 'housekeeping'],
    category: 'Home Services',
    icon: 'sparkles',
    services: [
      { name: 'Standard Clean', price: [120, 180], unit: 'per-session', duration: '2–3 hrs' },
      { name: 'Deep Clean', price: [240, 380], unit: 'per-session', duration: '4–6 hrs' },
      { name: 'Move-In / Move-Out Clean', price: [320, 520], unit: 'project', duration: '5–7 hrs' },
      { name: 'Recurring Biweekly Plan', price: [220, 320], unit: 'monthly' },
    ],
    tiers: ['Fresh Start', 'Deep Refresh', 'Spotless Plus'],
    booking: 'book',
    hours: 'Mon–Sat · 8:00 AM – 6:00 PM',
    bookingFlow: ['Online quote form with home size and add-ons', 'Instant price estimate and calendar booking', 'Confirmation text with cleaner profile and arrival window', 'Post-clean photo report and review request'],
    delivery: ['Pre-visit checklist confirmed with the client', 'Room-by-room cleaning standard (kitchen, baths, living, bedrooms)', 'Quality check with photos before leaving', '24-hour re-clean promise for missed spots'],
    roles: ['Owner / operations lead', 'Two-person cleaning teams', 'Part-time scheduler and customer care'],
    tools: ['Scheduling and booking software', 'Eco-friendly supply kits per team', 'Route planning app', 'Review and referral automation'],
    revenue: ['Recurring biweekly and monthly plans', 'One-time deep and move-out cleans', 'Add-ons: inside oven, fridge, windows, laundry'],
    costs: ['Cleaner wages (45–55% of revenue)', 'Supplies and equipment (5–7%)', 'Insurance and bonding', 'Marketing and booking software'],
    kpis: ['Recurring client share', 'Average ticket', 'Re-clean rate under 2%', 'Review rating 4.8+'],
    bonuses: ['Free fridge clean-out on the first visit', 'Seasonal checklist for homeowners', 'Priority holiday booking'],
    guarantee: '100% satisfaction: if anything is missed, we come back within 24 hours and re-clean it free.',
  },
  {
    id: 'home-repair',
    label: 'Home Repair & HVAC',
    noun: 'Home Services',
    match: ['hvac', 'plumb', 'electric', 'handyman', 'repair', 'roof', 'contractor', 'remodel', 'painting', 'painter'],
    category: 'Home Services',
    icon: 'wrench',
    services: [
      { name: 'Diagnostic Visit', price: [79, 129], unit: 'per-session', duration: '1 hr' },
      { name: 'Standard Repair', price: [180, 450], unit: 'project' },
      { name: 'Seasonal Tune-Up', price: [99, 179], unit: 'per-session', duration: '1.5 hrs' },
      { name: 'Home Care Maintenance Plan', price: [19, 39], unit: 'monthly' },
    ],
    tiers: ['Essential Care', 'Comfort Plan', 'Total Home Protection'],
    booking: 'book',
    hours: 'Mon–Fri · 7:00 AM – 7:00 PM · Emergency line 24/7',
    bookingFlow: ['Online booking or call with 2-hour arrival windows', 'Technician dispatch with photo and ETA text', 'On-site diagnosis with upfront flat-rate quote', 'Digital invoice, warranty and review request'],
    delivery: ['Shoe covers and drop cloths on every job', 'Flat-rate pricing approved before work starts', 'Photo documentation of parts and fixes', 'Follow-up call within 48 hours'],
    roles: ['Owner / lead technician', 'Licensed technicians', 'Dispatcher and customer service rep'],
    tools: ['Field service management software', 'Stocked service vans', 'Flat-rate price book', 'Membership billing'],
    revenue: ['Repair tickets', 'Maintenance memberships (recurring)', 'Replacement installs and upgrades'],
    costs: ['Technician labor', 'Parts and inventory', 'Vehicles and fuel', 'Licensing, insurance and marketing'],
    kpis: ['Average ticket', 'Membership count', 'First-time fix rate', 'Call booking rate'],
    bonuses: ['Priority scheduling for members', '15% off repairs for members', 'Free annual safety inspection'],
    guarantee: '1-year workmanship warranty on every repair, and we arrive in the window or your diagnostic is free.',
  },
  {
    id: 'landscaping',
    label: 'Landscaping & Lawn Care',
    noun: 'Landscapes',
    match: ['landscap', 'lawn', 'garden service', 'yard', 'tree', 'snow removal', 'irrigation'],
    category: 'Home Services',
    icon: 'sprout',
    services: [
      { name: 'Weekly Mowing & Edging', price: [45, 75], unit: 'per-session' },
      { name: 'Seasonal Cleanup', price: [250, 650], unit: 'project' },
      { name: 'Mulch & Bed Refresh', price: [300, 900], unit: 'project' },
      { name: 'Full-Season Lawn Plan', price: [160, 280], unit: 'monthly' },
    ],
    tiers: ['Tidy Lawn', 'Curb Appeal', 'Estate Care'],
    booking: 'inquire',
    hours: 'Mon–Sat · 7:00 AM – 6:00 PM (seasonal)',
    bookingFlow: ['Request a quote with address and photos', 'Satellite or on-site measurement', 'Written proposal with season calendar', 'Auto-scheduled visits with day-before reminders'],
    delivery: ['Route-optimized weekly crews', 'Before/after photos for every project', 'Seasonal health check of turf and beds', 'Clean-up and blow-off on every visit'],
    roles: ['Owner / estimator', 'Crew leads', 'Seasonal crew members'],
    tools: ['Commercial mowers and trailer', 'Routing and scheduling app', 'Online proposals with e-sign', 'Autopay billing'],
    revenue: ['Recurring maintenance contracts', 'Seasonal cleanups', 'Hardscape and planting projects', 'Snow removal in winter'],
    costs: ['Crew labor', 'Equipment and fuel', 'Materials (mulch, plants, stone)', 'Insurance and marketing'],
    kpis: ['Contract renewal rate', 'Revenue per crew hour', 'Proposal close rate', 'Route density'],
    bonuses: ['Free spring aeration with full-season plans', 'Priority storm cleanup', 'Holiday lighting discount'],
    guarantee: 'If we miss a scheduled visit, the next one is on us.',
  },
  {
    id: 'salon',
    label: 'Salon & Beauty Studio',
    noun: 'Salon',
    match: ['salon', 'hair', 'nail', 'lash', 'brow', 'beauty studio', 'esthetic', 'spa', 'med spa', 'makeup artist'],
    category: 'Beauty & Wellness',
    icon: 'scissors',
    services: [
      { name: 'Signature Cut & Style', price: [55, 95], unit: 'per-session', duration: '60 min' },
      { name: 'Color & Gloss', price: [120, 220], unit: 'per-session', duration: '2 hrs' },
      { name: 'Express Facial', price: [65, 110], unit: 'per-session', duration: '45 min' },
      { name: 'Glow Membership', price: [79, 129], unit: 'monthly' },
    ],
    tiers: ['Refresh', 'Signature', 'Luxe Ritual'],
    booking: 'book',
    hours: 'Tue–Sat · 9:00 AM – 7:00 PM',
    bookingFlow: ['Online booking with stylist and service selection', 'Deposit to hold the appointment', 'Reminder texts 48 and 2 hours before', 'Rebook prompt and review request after the visit'],
    delivery: ['Consultation before every service', 'Personalized at-home care card', 'Product recommendations tied to the service', 'Follow-up message after 7 days'],
    roles: ['Owner / lead stylist', 'Stylists and estheticians', 'Front desk coordinator'],
    tools: ['Salon booking and POS software', 'Retail product inventory', 'SMS reminders', 'Loyalty program'],
    revenue: ['Services', 'Memberships', 'Retail products', 'Gift cards and packages'],
    costs: ['Stylist commission or booth rent', 'Product and backbar supplies', 'Rent and utilities', 'Marketing and software'],
    kpis: ['Rebooking rate', 'Retail attach rate', 'Chair utilization', 'Average ticket'],
    bonuses: ['Complimentary scalp treatment on first visit', 'Member-only pricing on retail', 'Birthday upgrade'],
    guarantee: 'Love it or we will adjust it free within 7 days.',
  },
  {
    id: 'barber',
    label: 'Barbershop',
    noun: 'Barbers',
    match: ['barber', 'barbershop', 'shave', 'fade'],
    category: 'Beauty & Wellness',
    icon: 'scissors',
    services: [
      { name: 'Classic Cut', price: [30, 45], unit: 'per-session', duration: '30 min' },
      { name: 'Cut & Beard Sculpt', price: [45, 65], unit: 'per-session', duration: '45 min' },
      { name: 'Hot Towel Shave', price: [35, 55], unit: 'per-session', duration: '40 min' },
      { name: 'Unlimited Cuts Club', price: [59, 89], unit: 'monthly' },
    ],
    tiers: ['The Quick Trim', 'The Regular', 'The Full Service'],
    booking: 'book',
    hours: 'Mon–Sat · 9:00 AM – 8:00 PM · Sun 10–4',
    bookingFlow: ['Online booking by barber', 'Walk-in waitlist with text alerts', 'Reminder text the morning of', 'Rebook link sent after checkout'],
    delivery: ['Consult on style and maintenance', 'Hot towel finish on every service', 'Product recommendation', 'Rebook in 3–4 weeks'],
    roles: ['Owner / master barber', 'Barbers', 'Shop manager'],
    tools: ['Booking app', 'POS with tipping', 'Product shelf', 'Membership billing'],
    revenue: ['Cuts and shaves', 'Monthly clubs', 'Grooming products'],
    costs: ['Barber commission', 'Rent', 'Supplies', 'Marketing'],
    kpis: ['Client retention', 'Club members', 'Average ticket', 'Chair utilization'],
    bonuses: ['Free beard oil with first club month', 'Priority Saturday slots', 'Bring-a-friend credit'],
    guarantee: 'Not sharp enough? Come back within 5 days for a free touch-up.',
  },
  {
    id: 'fitness-studio',
    label: 'Fitness Studio & Personal Training',
    noun: 'Fitness',
    match: ['personal train', 'fitness studio', 'gym', 'yoga studio', 'pilates studio', 'bootcamp', 'crossfit', 'trainer', 'yoga', 'pilates'],
    category: 'Fitness & Health',
    icon: 'dumbbell',
    services: [
      { name: '1:1 Training Session', price: [70, 120], unit: 'per-session', duration: '60 min' },
      { name: 'Small Group Class Pack (10)', price: [180, 260], unit: 'project' },
      { name: 'Unlimited Membership', price: [129, 199], unit: 'monthly' },
      { name: '6-Week Kickstart Program', price: [299, 499], unit: 'project' },
    ],
    tiers: ['Starter', 'Committed', 'All-Access'],
    booking: 'book',
    hours: 'Mon–Fri · 6:00 AM – 8:00 PM · Sat 8–12',
    bookingFlow: ['Free intro session booking', 'Goal and movement assessment', 'Plan recommendation and membership signup', 'Class booking app with waitlists'],
    delivery: ['Initial assessment and goal setting', 'Programmed sessions with progress tracking', 'Monthly check-in and re-assessment', 'Community challenges every quarter'],
    roles: ['Owner / head coach', 'Certified trainers', 'Front desk and sales'],
    tools: ['Class booking software', 'Workout programming app', 'Body composition scanner', 'Member community chat'],
    revenue: ['Memberships', 'Personal training', 'Programs and challenges', 'Retail and recovery add-ons'],
    costs: ['Coach pay', 'Rent and equipment', 'Software', 'Marketing'],
    kpis: ['Member retention', 'Intro-to-member conversion', 'Average sessions per member', 'Monthly recurring revenue'],
    bonuses: ['Free nutrition kickoff call', 'Progress photo check-ins', 'Bring-a-friend Fridays'],
    guarantee: 'Show up for 6 weeks and if you don’t feel stronger, your next month is free.',
  },
  {
    id: 'cafe',
    label: 'Café & Bakery',
    noun: 'Bakehouse',
    match: ['cafe', 'café', 'coffee', 'bakery', 'bake', 'donut', 'tea', 'juice', 'roaster', 'dessert', 'ice cream'],
    category: 'Food & Drink',
    icon: 'coffee',
    services: [
      { name: 'Coffee & Pastry Combo', price: [8, 12], unit: 'one-time' },
      { name: 'Office Catering Box (serves 10)', price: [85, 140], unit: 'project' },
      { name: 'Custom Celebration Cake', price: [55, 160], unit: 'project' },
      { name: 'Coffee Subscription', price: [22, 38], unit: 'monthly' },
    ],
    tiers: ['Morning Box', 'Office Favorite', 'Celebration Spread'],
    booking: 'buy',
    hours: 'Daily · 7:00 AM – 4:00 PM',
    bookingFlow: ['Online ordering for pickup', 'Catering request with date and headcount', 'Order-ready text', 'Loyalty points at checkout'],
    delivery: ['Daily bake schedule and prep list', 'Seasonal menu rotation', 'Catering delivered setup-ready', 'Feedback card in every box'],
    roles: ['Owner / head baker', 'Baristas and counter staff', 'Morning bake team'],
    tools: ['POS with online ordering', 'Loyalty app', 'Inventory and waste tracker', 'Catering calendar'],
    revenue: ['Walk-in sales', 'Catering and custom orders', 'Coffee subscriptions', 'Wholesale to local businesses'],
    costs: ['Ingredients (28–32% food cost)', 'Labor', 'Rent and utilities', 'Packaging and marketing'],
    kpis: ['Average ticket', 'Food cost %', 'Daily covers', 'Loyalty repeat rate'],
    bonuses: ['Free drink on your 5th visit', 'Birthday pastry', 'Early access to seasonal menu'],
    guarantee: 'Not your favorite? Tell us and the next one is on the house.',
  },
  {
    id: 'restaurant',
    label: 'Restaurant & Food Truck',
    noun: 'Kitchen',
    match: ['restaurant', 'food truck', 'taqueria', 'pizzeria', 'pizza', 'bistro', 'diner', 'grill', 'kitchen', 'catering', 'bar', 'brewery'],
    category: 'Food & Drink',
    icon: 'utensils',
    services: [
      { name: 'Dinner for Two Bundle', price: [38, 65], unit: 'one-time' },
      { name: 'Family Meal Pack', price: [45, 85], unit: 'one-time' },
      { name: 'Private Event Catering', price: [18, 35], unit: 'quote' },
      { name: 'Weekly Meal Club', price: [89, 149], unit: 'monthly' },
    ],
    tiers: ['Weeknight Feast', 'Family Table', 'Party Platter'],
    booking: 'buy',
    hours: 'Tue–Sun · 11:00 AM – 10:00 PM',
    bookingFlow: ['Direct online ordering and reservations', 'Catering inquiry with date, headcount and menu', 'Order confirmation and ready text', 'Review and loyalty invite after the meal'],
    delivery: ['Consistent recipes with plated photos', 'Pre-shift lineup with specials', 'Catering setup checklist', 'Guest feedback loop every week'],
    roles: ['Owner / chef', 'Line cooks', 'Front-of-house team', 'Catering coordinator'],
    tools: ['POS with online ordering', 'Reservation system', 'Inventory and food cost tracking', 'Email and SMS marketing'],
    revenue: ['Dine-in', 'Direct takeout and delivery', 'Catering and private events', 'Meal club subscriptions'],
    costs: ['Food cost (28–35%)', 'Labor (30%)', 'Rent and utilities', 'Delivery platform fees'],
    kpis: ['Covers per night', 'Average check', 'Food cost %', 'Direct vs. app order mix'],
    bonuses: ['Free dessert for reservations Tue–Thu', 'Kids eat free Sundays', 'Catering tasting for events of 30+'],
    guarantee: 'If a dish isn’t right, we’ll remake it or take it off the bill.',
  },
  {
    id: 'photography',
    label: 'Photography & Video Studio',
    noun: 'Studio',
    match: ['photograph', 'photo studio', 'videograph', 'video production', 'headshot', 'portrait'],
    category: 'Creative & Events',
    icon: 'camera',
    services: [
      { name: 'Headshot Session', price: [150, 300], unit: 'per-session', duration: '45 min' },
      { name: 'Family / Lifestyle Session', price: [300, 600], unit: 'per-session', duration: '90 min' },
      { name: 'Brand Content Day', price: [900, 1800], unit: 'project' },
      { name: 'Wedding Collection', price: [2800, 5500], unit: 'project' },
    ],
    tiers: ['Mini Session', 'Signature Session', 'Brand Day'],
    booking: 'inquire',
    hours: 'By appointment · Mon–Sat',
    bookingFlow: ['Inquiry form with date, type and goals', 'Discovery call and mood board', 'Contract and retainer online', 'Shot list and location prep guide'],
    delivery: ['Pre-session style guide', 'Directed session with posing', 'Gallery delivered in 10 business days', 'Print and album upsell'],
    roles: ['Owner / lead photographer', 'Second shooter', 'Editor (contract)'],
    tools: ['Client portal and contracts', 'Online gallery delivery', 'Editing presets', 'Print lab partner'],
    revenue: ['Session fees', 'Brand retainers', 'Prints and albums', 'Workshops and presets'],
    costs: ['Gear and insurance', 'Editing time', 'Studio rent', 'Marketing'],
    kpis: ['Inquiry-to-booking rate', 'Average collection value', 'Referral rate', 'Delivery time'],
    bonuses: ['Free outfit consultation', '5 bonus edited images', 'Social media crop pack'],
    guarantee: 'If you don’t love your gallery, we reshoot at no cost.',
  },
  {
    id: 'consulting',
    label: 'Consulting & Agency',
    noun: 'Partners',
    match: ['consult', 'agency', 'marketing agency', 'strategy', 'advisor', 'web design', 'seo agency', 'social media manager', 'virtual assistant'],
    category: 'Professional Services',
    icon: 'briefcase',
    services: [
      { name: 'Strategy Intensive', price: [750, 1500], unit: 'project' },
      { name: 'Monthly Retainer', price: [1500, 4000], unit: 'monthly' },
      { name: 'Audit & Roadmap', price: [450, 950], unit: 'project' },
      { name: 'Done-for-You Implementation', price: [2500, 7500], unit: 'project' },
    ],
    tiers: ['Audit', 'Growth Retainer', 'Partner'],
    booking: 'inquire',
    hours: 'Mon–Fri · 9:00 AM – 5:00 PM',
    bookingFlow: ['Application or discovery call booking', 'Diagnostic call and fit check', 'Proposal with scope and timeline', 'Kickoff with onboarding questionnaire'],
    delivery: ['Kickoff workshop', 'Weekly sprints with async updates', 'Monthly performance report', 'Quarterly strategy review'],
    roles: ['Founder / lead strategist', 'Specialists (contract)', 'Project manager'],
    tools: ['CRM and proposal software', 'Project management board', 'Reporting dashboards', 'Shared client portal'],
    revenue: ['Retainers', 'Fixed-scope projects', 'Workshops and training', 'Affiliate tool partnerships'],
    costs: ['Contractor fees', 'Software stack', 'Sales and marketing', 'Insurance'],
    kpis: ['Monthly recurring revenue', 'Client retention', 'Utilization', 'Proposal win rate'],
    bonuses: ['Free competitor audit', 'Template library access', 'Priority Slack channel'],
    guarantee: 'If we don’t hit the milestones in your plan, we keep working at no extra cost until we do.',
  },
  {
    id: 'bookkeeping',
    label: 'Bookkeeping & Accounting',
    noun: 'Bookkeeping',
    match: ['bookkeep', 'accounting', 'accountant', 'cpa', 'tax prep', 'payroll'],
    category: 'Professional Services',
    icon: 'calculator',
    services: [
      { name: 'Monthly Bookkeeping', price: [250, 650], unit: 'monthly' },
      { name: 'Catch-Up Bookkeeping', price: [600, 1800], unit: 'project' },
      { name: 'Small Business Tax Return', price: [450, 1200], unit: 'project' },
      { name: 'Payroll Setup & Run', price: [79, 199], unit: 'monthly' },
    ],
    tiers: ['Essentials', 'Growth', 'CFO Lite'],
    booking: 'inquire',
    hours: 'Mon–Fri · 8:30 AM – 5:30 PM',
    bookingFlow: ['Free 20-minute fit call', 'Secure document upload checklist', 'Fixed-fee proposal', 'Onboarding and account connections'],
    delivery: ['Monthly reconciliation by the 10th', 'Profit & loss and cash flow summary', 'Quarterly tax estimate reminder', 'Year-end tax-ready package'],
    roles: ['Owner / accountant', 'Bookkeepers', 'Client success coordinator'],
    tools: ['Cloud accounting software', 'Secure client portal', 'Receipt capture app', 'Practice management software'],
    revenue: ['Monthly bookkeeping plans', 'Tax preparation', 'Catch-up projects', 'Advisory hours'],
    costs: ['Staff', 'Software licenses', 'Insurance and compliance', 'Marketing'],
    kpis: ['Clients per bookkeeper', 'On-time close rate', 'Client retention', 'Average monthly fee'],
    bonuses: ['Free first-month catch-up review', 'Quarterly planning session', 'Year-end tax organizer'],
    guarantee: 'Books closed by the 10th every month, or that month is free.',
  },
  {
    id: 'tutoring',
    label: 'Tutoring & Learning Center',
    noun: 'Learning',
    match: ['tutor', 'tutoring', 'learning center', 'test prep', 'music lesson', 'piano', 'language school', 'coding class'],
    category: 'Education & Tutoring',
    icon: 'graduation-cap',
    services: [
      { name: '1:1 Tutoring Session', price: [55, 95], unit: 'per-session', duration: '60 min' },
      { name: 'Test Prep Bootcamp', price: [450, 900], unit: 'project' },
      { name: 'Homework Club (monthly)', price: [180, 320], unit: 'monthly' },
      { name: 'Learning Assessment', price: [95, 150], unit: 'per-session' },
    ],
    tiers: ['Boost', 'Steady Progress', 'Exam Ready'],
    booking: 'book',
    hours: 'Mon–Thu · 3:00 PM – 8:00 PM · Sat 9–1',
    bookingFlow: ['Free assessment booking', 'Learning plan shared with parents', 'Recurring session schedule', 'Monthly progress report'],
    delivery: ['Baseline assessment', 'Personalized learning plan', 'Weekly sessions with practice sets', 'Parent progress check-ins'],
    roles: ['Director / lead tutor', 'Subject tutors', 'Parent coordinator'],
    tools: ['Scheduling and billing software', 'Assessment library', 'Progress tracking dashboard', 'Video sessions'],
    revenue: ['Recurring tutoring packages', 'Bootcamps', 'Assessments', 'Summer programs'],
    costs: ['Tutor pay', 'Space rent', 'Materials and software', 'Marketing'],
    kpis: ['Student retention', 'Score improvement', 'Sessions per week', 'Referral rate'],
    bonuses: ['Free practice test', 'Parent strategy guide', 'Priority exam-season slots'],
    guarantee: 'If scores don’t improve after 8 sessions, the next 4 are free.',
  },
  {
    id: 'pet-services',
    label: 'Pet Grooming & Care',
    noun: 'Pet Spa',
    match: ['groom', 'pet', 'dog walk', 'pet sit', 'dog train', 'boarding', 'daycare'],
    category: 'Pet Services',
    icon: 'paw-print',
    services: [
      { name: 'Bath & Brush', price: [45, 75], unit: 'per-session', duration: '60 min' },
      { name: 'Full Groom', price: [70, 120], unit: 'per-session', duration: '2 hrs' },
      { name: 'Daily Dog Walks (weekly)', price: [100, 175], unit: 'per-session' },
      { name: 'Wellness Grooming Club', price: [59, 99], unit: 'monthly' },
    ],
    tiers: ['Fresh Pup', 'Full Pamper', 'VIP Club'],
    booking: 'book',
    hours: 'Tue–Sat · 8:00 AM – 5:00 PM',
    bookingFlow: ['Online booking with pet profile', 'Vaccination record upload', 'Drop-off with style notes', 'Pick-up text with photo'],
    delivery: ['Nose-to-tail health check', 'Low-stress handling', 'Photo update before pickup', 'Rebook reminder every 6 weeks'],
    roles: ['Owner / lead groomer', 'Bathers and groomers', 'Receptionist'],
    tools: ['Pet booking software', 'Grooming tables and dryers', 'SMS updates', 'Membership billing'],
    revenue: ['Grooms', 'Memberships', 'Add-ons (teeth, nails, de-shed)', 'Retail treats and shampoos'],
    costs: ['Groomer pay', 'Supplies', 'Rent', 'Insurance'],
    kpis: ['Rebook rate', 'Average ticket', 'Members', 'No-show rate'],
    bonuses: ['Free nail trim between visits', 'Birthday bandana', 'Priority holiday booking'],
    guarantee: 'Not happy with the cut? We’ll fix it free within 3 days.',
  },
  {
    id: 'auto',
    label: 'Auto Detailing & Repair',
    noun: 'Auto Spa',
    match: ['detail', 'auto', 'car', 'mechanic', 'tire', 'oil change', 'body shop', 'car wash'],
    category: 'Automotive',
    icon: 'car',
    services: [
      { name: 'Express Detail', price: [79, 129], unit: 'per-session', duration: '90 min' },
      { name: 'Full Interior + Exterior Detail', price: [179, 299], unit: 'per-session', duration: '4 hrs' },
      { name: 'Ceramic Coating', price: [600, 1400], unit: 'project' },
      { name: 'Monthly Maintenance Wash', price: [49, 89], unit: 'monthly' },
    ],
    tiers: ['Quick Shine', 'Showroom', 'Protection Package'],
    booking: 'book',
    hours: 'Mon–Sat · 8:00 AM – 6:00 PM',
    bookingFlow: ['Online booking by vehicle size', 'Mobile or shop service option', 'Arrival text with photo check-in', 'Before/after photos and review request'],
    delivery: ['Walk-around inspection', 'Interior steam and extraction', 'Paint decontamination and protection', 'Final quality inspection with the client'],
    roles: ['Owner / lead detailer', 'Detail technicians', 'Booking coordinator'],
    tools: ['Mobile detailing rig', 'Booking and invoicing app', 'Pro-grade products', 'Membership billing'],
    revenue: ['Details', 'Coatings and protection', 'Memberships', 'Fleet contracts'],
    costs: ['Labor', 'Products and water', 'Vehicle and fuel', 'Insurance'],
    kpis: ['Average ticket', 'Membership count', 'Jobs per day', 'Review rating'],
    bonuses: ['Free air freshener and tire shine', 'Member-only coating discount', 'Rainy-day rewash'],
    guarantee: 'If it rains within 48 hours of an exterior detail, the rewash is free.',
  },
  {
    id: 'event-planning',
    label: 'Event Planning & Florals',
    noun: 'Events',
    match: ['wedding', 'event', 'planner', 'florist', 'floral', 'dj', 'party', 'rental'],
    category: 'Creative & Events',
    icon: 'gem',
    services: [
      { name: 'Day-of Coordination', price: [1200, 2200], unit: 'project' },
      { name: 'Partial Planning', price: [2500, 4500], unit: 'project' },
      { name: 'Full-Service Planning', price: [5000, 9500], unit: 'project' },
      { name: 'Event Florals', price: [800, 3500], unit: 'quote' },
    ],
    tiers: ['Day-Of', 'Partial Planning', 'Full Service'],
    booking: 'inquire',
    hours: 'By appointment · Mon–Sat',
    bookingFlow: ['Inquiry with date, guest count and vision', 'Consultation and mood board', 'Proposal, contract and retainer', 'Planning portal with checklists and timeline'],
    delivery: ['Vendor shortlist and bookings', 'Budget tracker and payment schedule', 'Final walkthrough and run of show', 'Day-of team and setup/teardown'],
    roles: ['Owner / lead planner', 'Assistant planners', 'Floral designer'],
    tools: ['Planning software with client portal', 'Budget tracker', 'Vendor CRM', 'Contracts and invoicing'],
    revenue: ['Planning packages', 'Florals and decor', 'Rentals', 'Vendor referral partnerships'],
    costs: ['Staff and day-of team', 'Floral and decor inventory', 'Insurance', 'Marketing and styled shoots'],
    kpis: ['Inquiry-to-booking rate', 'Average package value', 'Referral share', 'Client satisfaction'],
    bonuses: ['Complimentary engagement shoot styling', 'Vendor discount network', 'Day-after brunch coordination'],
    guarantee: 'Every timeline item delivered as planned, or we refund the portion that wasn’t.',
  },
  {
    id: 'retail',
    label: 'Boutique & Retail Shop',
    noun: 'Goods',
    match: ['boutique', 'retail', 'shop', 'store', 'gift', 'apparel', 'clothing', 'florist shop', 'bookstore', 'plant shop', 'thrift'],
    category: 'Retail & Boutiques',
    icon: 'shopping-bag',
    services: [
      { name: 'Curated Gift Box', price: [45, 95], unit: 'one-time' },
      { name: 'Personal Styling Session', price: [60, 120], unit: 'per-session', duration: '60 min' },
      { name: 'Monthly Subscription Box', price: [35, 65], unit: 'monthly' },
      { name: 'Corporate Gifting (per box)', price: [50, 150], unit: 'quote' },
    ],
    tiers: ['Little Treat', 'Signature Box', 'VIP Styling'],
    booking: 'buy',
    hours: 'Mon–Sat · 10:00 AM – 7:00 PM · Sun 11–5',
    bookingFlow: ['Shop online or in-store', 'Free local pickup or delivery', 'Gift note and wrapping options', 'VIP list invite after purchase'],
    delivery: ['Seasonal merchandising refresh', 'Local maker collaborations', 'Same-day local delivery', 'Monthly VIP shopping night'],
    roles: ['Owner / buyer', 'Sales associates', 'Online store and fulfillment'],
    tools: ['POS with online store', 'Inventory system', 'Email and SMS marketing', 'Loyalty program'],
    revenue: ['In-store sales', 'Online orders', 'Subscriptions', 'Corporate gifting'],
    costs: ['Inventory (cost of goods 45–55%)', 'Rent', 'Staff', 'Marketing and shipping'],
    kpis: ['Sales per square foot', 'Sell-through rate', 'Repeat customer rate', 'Average order value'],
    bonuses: ['Free gift wrap', 'Birthday discount', 'Early access to new arrivals'],
    guarantee: 'Easy 30-day returns or exchanges, no questions asked.',
  },
];

export function matchBusinessType(text: string): BusinessType {
  const t = text.toLowerCase();
  let best = BUSINESS_TYPES[BUSINESS_TYPES.length - 1];
  let bestScore = 0;
  for (const bt of BUSINESS_TYPES) {
    let score = 0;
    for (const m of bt.match) if (t.includes(m)) score += 2 + m.length / 8;
    if (score > bestScore) {
      bestScore = score;
      best = bt;
    }
  }
  if (bestScore === 0) return GENERIC_BUSINESS;
  return best;
}

/** What customers of each local business type struggle with and want: used instead of broad niche data on the business track. */
export const BUSINESS_VOICE: Record<string, { pains: string[]; outcomes: string[] }> = {
  cleaning: {
    pains: ['weekends lost to scrubbing and laundry', 'cleaners who cancel last minute', 'never quite getting the whole house clean', 'coming home to clutter after a long day'],
    outcomes: ['come home to a spotless house every week', 'get your weekends back', 'trust the same vetted cleaner every visit'],
  },
  'home-repair': {
    pains: ['a repair list that never shrinks', 'contractors who never call back', 'surprise charges on the final bill', 'small leaks turning into big repairs'],
    outcomes: ['get every repair done right the first time', 'know the price before work starts', 'keep your home in top shape year-round'],
  },
  landscaping: {
    pains: ['an overgrown yard that eats your weekends', 'patchy, brown lawn spots', 'crews that show up whenever they like', 'a yard you avoid showing guests'],
    outcomes: ['enjoy a yard you are proud of', 'get your weekends back', 'keep a healthy, green lawn all season'],
  },
  salon: {
    pains: ['cuts that look nothing like the photo', 'color that fades in two weeks', 'appointments that run late', 'stylists who don’t listen'],
    outcomes: ['leave with exactly the look you asked for', 'keep your color vibrant for weeks', 'book a stylist who remembers you'],
  },
  barber: {
    pains: ['long walk-in waits', 'inconsistent cuts from different barbers', 'fades that grow out in days', 'booking hassles'],
    outcomes: ['look sharp every week', 'book your barber in seconds', 'get the same great cut every time'],
  },
  'fitness-studio': {
    pains: ['workouts that never stick', 'crowded gyms and waiting for equipment', 'second-guessing your form', 'paying for a membership you never use'],
    outcomes: ['build a routine you actually keep', 'get stronger with coaching on every rep', 'see real progress in 30 days'],
  },
  cafe: {
    pains: ['burnt, bitter coffee', 'long lines before work', 'nowhere cozy to work or meet', 'the same tired pastries'],
    outcomes: ['grab a perfect cup on the way to work', 'find your new favorite neighborhood spot', 'treat yourself to something fresh every day'],
  },
  restaurant: {
    pains: ['long waits for a table', 'bland takeout that arrives cold', 'menus that never change', 'special occasions that fall flat'],
    outcomes: ['enjoy a memorable meal close to home', 'get fresh food delivered hot', 'make every celebration feel special'],
  },
  photography: {
    pains: ['stiff, awkward photos', 'waiting months for your gallery', 'photos that don’t look like you', 'missing the moments that matter'],
    outcomes: ['get photos you will actually frame', 'feel relaxed and natural on camera', 'receive your gallery within two weeks'],
  },
  consulting: {
    pains: ['growth that has stalled', 'too many priorities and no plan', 'agencies that report vanity metrics', 'doing everything yourself'],
    outcomes: ['get a clear plan with measurable milestones', 'grow without hiring a full team', 'know exactly what to do next'],
  },
  bookkeeping: {
    pains: ['shoeboxes of receipts', 'surprise tax bills', 'books that are months behind', 'guessing whether you are profitable'],
    outcomes: ['have clean books every month', 'walk into tax season calm', 'know your numbers at a glance'],
  },
  tutoring: {
    pains: ['falling grades and homework battles', 'test anxiety', 'gaps left from earlier grades', 'not knowing how to help at home'],
    outcomes: ['raise grades within a semester', 'walk into exams confident', 'build study habits that last'],
  },
  'pet-services': {
    pains: ['matted coats and overgrown nails', 'stressful trips to the groomer', 'groomers booked weeks out', 'worrying about your pet while you work'],
    outcomes: ['bring home a happy, freshly groomed pet', 'book trusted pet care in minutes', 'keep your pet calm, clean and healthy'],
  },
  auto: {
    pains: ['a car that never feels clean', 'swirl marks and faded paint', 'shops that upsell everything', 'waiting all day at the shop'],
    outcomes: ['drive a car that looks showroom-new', 'protect your paint for months', 'get honest service on your schedule'],
  },
  'event-planning': {
    pains: ['juggling dozens of vendors', 'last-minute surprises on the big day', 'budgets that spiral', 'decor that misses your vision'],
    outcomes: ['enjoy your event instead of running it', 'stay on budget without compromise', 'bring your vision to life'],
  },
  retail: {
    pains: ['the same mass-produced styles everyone has', 'guessing sizes online', 'returns that are a hassle', 'never finding the right gift'],
    outcomes: ['find pieces you won’t see everywhere', 'shop local with easy returns', 'always have the perfect gift ready'],
  },
  service: {
    pains: ['providers who don’t show up on time', 'unclear pricing', 'hard-to-book appointments', 'service that varies every visit'],
    outcomes: ['get reliable service every time', 'know the price upfront', 'book in minutes'],
  },
};

export const GENERIC_BUSINESS: BusinessType = {
  id: 'service',
  label: 'Service Business',
  noun: 'Co.',
  match: [],
  category: 'Professional Services',
  icon: 'store',
  services: [
    { name: 'Consultation', price: [0, 0], unit: 'free', duration: '20 min' },
    { name: 'Standard Service', price: [95, 180], unit: 'per-session' },
    { name: 'Premium Package', price: [350, 750], unit: 'project' },
    { name: 'Ongoing Care Plan', price: [79, 149], unit: 'monthly' },
  ],
  tiers: ['Essential', 'Signature', 'Premium'],
  booking: 'book',
  hours: 'Mon–Fri · 9:00 AM – 6:00 PM',
  bookingFlow: ['Online booking or inquiry form', 'Confirmation with prep details', 'Reminder 24 hours before', 'Follow-up and review request'],
  delivery: ['Intake to understand goals', 'Service delivered to a written standard', 'Quality check before completion', 'Follow-up within one week'],
  roles: ['Owner / operator', 'Service team', 'Customer care'],
  tools: ['Booking and invoicing software', 'CRM', 'Review automation', 'Email marketing'],
  revenue: ['Services', 'Packages', 'Recurring care plans', 'Referral partnerships'],
  costs: ['Labor', 'Supplies', 'Software', 'Marketing and insurance'],
  kpis: ['Repeat customer rate', 'Average ticket', 'Bookings per week', 'Review rating'],
  bonuses: ['Free follow-up check', 'Priority booking for returning clients', 'Referral credit'],
  guarantee: 'If you are not happy, we make it right or refund the service.',
};

export const BUSINESS_CATEGORIES = [
  'Home Services',
  'Food & Drink',
  'Beauty & Wellness',
  'Fitness & Health',
  'Professional Services',
  'Retail & Boutiques',
  'Creative & Events',
  'Pet Services',
  'Education & Tutoring',
  'Automotive',
];

export const PRODUCT_CATEGORIES = [
  'Personal Finance',
  'Fitness & Training',
  'Health & Nutrition',
  'B2B SaaS & Sales',
  'Marketing & Content',
  'Real Estate',
  'Productivity & Systems',
  'Education & Teaching',
  'Parenting & Family',
  'Food & Cooking',
  'Beauty & Self-Care',
  'Home & Garden',
  'Pets',
  'Design & Creative',
  'Career & Coaching',
  'E-commerce & Retail',
  'Mindfulness & Mental Wellness',
  'Tech, AI & No-Code',
  'Travel',
];

// ───────────────────────── Social styles, post types, platforms ─────────────────────────
export interface StyleDef<T extends string> {
  id: T;
  label: string;
  desc: string;
  prompt: string;
  /** the same look without on-image lettering, for generated artwork (the app sets the text itself) */
  art?: string;
  bestFor: string;
}

export const IMAGE_STYLES: StyleDef<ImageStyleId>[] = [
  { id: 'minimal', label: 'Minimalist Studio', desc: 'Seamless soft backdrop, one hero object, generous negative space.', prompt: 'minimalist studio shot, seamless pastel backdrop, soft diffused light, single centered hero object, generous negative space, subtle shadow', bestFor: 'Product launches and premium offers' },
  { id: 'neon', label: 'Bold Typography & Neon', desc: 'Oversized type with neon glow on a dark backdrop.', prompt: 'bold oversized typography poster, neon glow lettering, dark backdrop, high contrast, punchy color accents', art: 'glowing neon light shapes and lines on a dark backdrop, high contrast, punchy color accents, soft light bloom', bestFor: 'Hooks, announcements and hot takes' },
  { id: 'editorial', label: 'Editorial Lifestyle', desc: 'Magazine-style photo with a refined serif headline.', prompt: 'editorial lifestyle photograph, natural window light, candid real moment, magazine layout with elegant serif headline', art: 'editorial lifestyle photograph, natural window light, candid real moment, calm magazine-style composition', bestFor: 'Stories, testimonials and brand moments' },
  { id: 'isometric', label: '3D Isometric Tech', desc: 'Isometric 3D scene with floating UI cards.', prompt: 'isometric 3D illustration, floating interface cards, soft gradient lighting, clean tech aesthetic, depth and shadows', bestFor: 'Software, systems and how-it-works posts' },
  { id: 'handcrafted', label: 'Warm Handcrafted Infographic', desc: 'Hand-drawn numbered steps and doodles on warm paper.', prompt: 'warm hand-drawn infographic, textured paper, doodle icons, numbered steps, friendly handwritten lettering', art: 'warm hand-drawn illustration on textured paper, doodle-style icons and simple shapes, friendly and playful', bestFor: 'Tips, checklists and step-by-step guides' },
];

export const VIDEO_STYLES: StyleDef<VideoStyleId>[] = [
  { id: 'ugc', label: 'Fast-Paced UGC Hook', desc: 'Selfie-style clips, jump cuts and bold captions in the first second.', prompt: 'vertical selfie-style UGC video, handheld, jump cuts every second, bold burned-in captions, natural light', bestFor: 'Reach and relatability' },
  { id: 'kinetic', label: 'Kinetic Text Reel', desc: 'Animated type that punches each word on the beat.', prompt: 'kinetic typography reel, words animate on the beat, bold color flashes, smooth motion transitions', bestFor: 'Tips and quotes without filming' },
  { id: 'split', label: 'Split-Screen Explainer', desc: 'Before/after or problem/solution side by side.', prompt: 'split-screen vertical video, before and after comparison, labeled halves, clean wipe transitions', bestFor: 'Transformations and comparisons' },
  { id: 'cinematic', label: 'Cinematic Product B-Roll', desc: 'Slow, moody close-ups with film grain and letterbox.', prompt: 'cinematic product b-roll, slow dolly close-ups, shallow depth of field, film grain, letterbox, moody light', bestFor: 'Premium products and launches' },
  { id: 'talking', label: 'Talking-Head + B-Roll Overlay', desc: 'Face-to-camera advice with captions and cutaways.', prompt: 'talking-head vertical video, face to camera, captioned lower thirds, b-roll cutaways overlaid', bestFor: 'Authority, education and trust' },
];

export const STYLE_LABEL: Record<string, string> = Object.fromEntries(
  [...IMAGE_STYLES, ...VIDEO_STYLES].map((s) => [s.id, s.label]),
);

export const isVideoStyle = (s: string): boolean => VIDEO_STYLES.some((v) => v.id === s);

export interface PostTypeDef {
  id: PostType;
  label: string;
  short: string;
  desc: string;
  slot: string;
  goal: string;
}

export const POST_TYPES: PostTypeDef[] = [
  { id: 'educational', label: 'Educational / How-To', short: 'How-to', desc: 'Teach a process step by step.', slot: 'c1', goal: 'Saves and authority' },
  { id: 'tip', label: 'Quick Actionable Tip', short: 'Quick tip', desc: 'One tip they can use today.', slot: 'c2', goal: 'Shares and follows' },
  { id: 'question', label: 'Open Question for Community', short: 'Question', desc: 'Spark comments and conversation.', slot: 'c3', goal: 'Comments and reach' },
  { id: 'sales', label: 'Advertising / Direct Sales', short: 'Sales', desc: 'Drive clicks to the offer.', slot: 'c4', goal: 'Clicks and conversions' },
  { id: 'bts', label: 'Behind-the-Scenes / Social Proof', short: 'BTS & proof', desc: 'Show the people, process and results.', slot: 'c5', goal: 'Trust and loyalty' },
];

export const POST_TYPE_MAP = Object.fromEntries(POST_TYPES.map((p) => [p.id, p])) as Record<PostType, PostTypeDef>;

export interface PlatformDef {
  id: SocialPlatform;
  label: string;
  color: string;
  times: string[];
  limit: number;
  hashtags: number;
  handlePrefix: string;
  reachMult: number;
  b2b: number;
}

export const PLATFORMS: Record<SocialPlatform, PlatformDef> = {
  instagram: { id: 'instagram', label: 'Instagram', color: '#D6297A', times: ['09:00', '12:00', '17:30', '19:30', '21:00'], limit: 2200, hashtags: 8, handlePrefix: '@', reachMult: 1, b2b: 0.6 },
  facebook: { id: 'facebook', label: 'Facebook', color: '#1877F2', times: ['09:00', '13:00', '15:00', '19:00', '20:30'], limit: 2000, hashtags: 3, handlePrefix: '', reachMult: 0.7, b2b: 0.7 },
  tiktok: { id: 'tiktok', label: 'TikTok', color: '#111111', times: ['07:00', '12:00', '16:00', '19:00', '22:00'], limit: 2200, hashtags: 5, handlePrefix: '@', reachMult: 1.6, b2b: 0.5 },
  linkedin: { id: 'linkedin', label: 'LinkedIn', color: '#0A66C2', times: ['08:00', '10:00', '12:00', '17:00', '18:30'], limit: 3000, hashtags: 3, handlePrefix: '', reachMult: 0.75, b2b: 1.6 },
  x: { id: 'x', label: 'X (Twitter)', color: '#111111', times: ['08:00', '12:00', '15:00', '18:00', '21:00'], limit: 280, hashtags: 2, handlePrefix: '@', reachMult: 0.6, b2b: 1.1 },
  youtube: { id: 'youtube', label: 'YouTube', color: '#E62117', times: ['12:00', '15:00', '18:00', '20:00', '21:00'], limit: 5000, hashtags: 3, handlePrefix: '@', reachMult: 1.2, b2b: 0.8 },
};

export const POST_PLATFORMS: PostPlatform[] = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x'];
export const SOCIAL_PLATFORMS: SocialPlatform[] = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'youtube'];

// ───────────────────────── Logo icon choices ─────────────────────────
export const LOGO_ICONS: { name: string; tags: string[] }[] = [
  { name: 'sparkles', tags: ['beauty', 'magic', 'ai', 'clean', 'glow'] },
  { name: 'leaf', tags: ['health', 'nutrition', 'eco', 'natural', 'wellness'] },
  { name: 'sprout', tags: ['garden', 'growth', 'home', 'plant', 'landscaping'] },
  { name: 'flower-2', tags: ['mindfulness', 'florist', 'calm', 'wedding'] },
  { name: 'sun', tags: ['morning', 'energy', 'travel', 'summer'] },
  { name: 'moon', tags: ['sleep', 'calm', 'night'] },
  { name: 'star', tags: ['premium', 'review', 'quality'] },
  { name: 'heart', tags: ['care', 'parenting', 'wellness', 'love'] },
  { name: 'zap', tags: ['energy', 'fast', 'tech', 'electric'] },
  { name: 'flame', tags: ['fitness', 'bbq', 'hot', 'motivation'] },
  { name: 'droplet', tags: ['skincare', 'plumbing', 'water', 'clean'] },
  { name: 'mountain', tags: ['travel', 'outdoor', 'summit', 'goal'] },
  { name: 'waves', tags: ['calm', 'pool', 'travel', 'flow'] },
  { name: 'compass', tags: ['travel', 'career', 'direction', 'coaching'] },
  { name: 'anchor', tags: ['stability', 'finance', 'harbor'] },
  { name: 'rocket', tags: ['startup', 'launch', 'growth', 'saas'] },
  { name: 'target', tags: ['marketing', 'goals', 'sales', 'focus'] },
  { name: 'gem', tags: ['luxury', 'wedding', 'premium', 'jewelry'] },
  { name: 'crown', tags: ['membership', 'premium', 'royal'] },
  { name: 'shield-check', tags: ['insurance', 'trust', 'security', 'repair'] },
  { name: 'key', tags: ['real estate', 'home', 'access'] },
  { name: 'house', tags: ['real estate', 'home', 'cleaning', 'services'] },
  { name: 'store', tags: ['retail', 'shop', 'local'] },
  { name: 'shopping-bag', tags: ['ecommerce', 'boutique', 'retail'] },
  { name: 'package', tags: ['shipping', 'product', 'box'] },
  { name: 'gift', tags: ['gifts', 'boutique', 'bonus'] },
  { name: 'coffee', tags: ['cafe', 'coffee', 'morning'] },
  { name: 'utensils', tags: ['restaurant', 'cooking', 'food'] },
  { name: 'cake-slice', tags: ['bakery', 'dessert', 'celebration'] },
  { name: 'dumbbell', tags: ['fitness', 'gym', 'strength'] },
  { name: 'bike', tags: ['fitness', 'cycling', 'outdoor'] },
  { name: 'activity', tags: ['health', 'fitness', 'pulse', 'analytics'] },
  { name: 'brain', tags: ['mindfulness', 'learning', 'ai', 'coaching'] },
  { name: 'lightbulb', tags: ['ideas', 'education', 'consulting'] },
  { name: 'book-open', tags: ['education', 'ebook', 'learning'] },
  { name: 'graduation-cap', tags: ['education', 'tutoring', 'course'] },
  { name: 'pen-tool', tags: ['design', 'creative', 'branding'] },
  { name: 'palette', tags: ['design', 'art', 'creative'] },
  { name: 'camera', tags: ['photography', 'video', 'creative'] },
  { name: 'music', tags: ['music', 'audio', 'dj'] },
  { name: 'headphones', tags: ['audio', 'podcast', 'music'] },
  { name: 'mic', tags: ['podcast', 'speaking', 'audio'] },
  { name: 'laptop', tags: ['tech', 'remote', 'software'] },
  { name: 'code-xml', tags: ['developer', 'tech', 'software'] },
  { name: 'cpu', tags: ['ai', 'tech', 'automation'] },
  { name: 'globe', tags: ['travel', 'global', 'web'] },
  { name: 'map-pin', tags: ['local', 'location', 'travel'] },
  { name: 'plane', tags: ['travel', 'trip'] },
  { name: 'car', tags: ['automotive', 'detailing', 'travel'] },
  { name: 'wrench', tags: ['repair', 'home services', 'mechanic'] },
  { name: 'hammer', tags: ['contractor', 'diy', 'renovation'] },
  { name: 'scissors', tags: ['salon', 'barber', 'craft'] },
  { name: 'paw-print', tags: ['pets', 'dog', 'cat'] },
  { name: 'baby', tags: ['parenting', 'family', 'kids'] },
  { name: 'briefcase', tags: ['career', 'consulting', 'business'] },
  { name: 'building-2', tags: ['professional', 'firm', 'office'] },
  { name: 'wallet', tags: ['finance', 'money', 'budget'] },
  { name: 'piggy-bank', tags: ['savings', 'finance', 'budget'] },
  { name: 'coins', tags: ['finance', 'money', 'revenue'] },
  { name: 'chart-line', tags: ['growth', 'analytics', 'finance'] },
  { name: 'trending-up', tags: ['sales', 'growth', 'marketing'] },
  { name: 'megaphone', tags: ['marketing', 'announcements'] },
  { name: 'layers', tags: ['systems', 'productivity', 'templates'] },
  { name: 'calendar-check', tags: ['planning', 'booking', 'productivity'] },
  { name: 'clock', tags: ['time', 'productivity'] },
  { name: 'hand-heart', tags: ['care', 'nonprofit', 'wellness'] },
];

export function suggestIcons(text: string, fallback: string): string[] {
  const t = text.toLowerCase();
  const scored = LOGO_ICONS.map((ic) => ({
    name: ic.name,
    score: ic.tags.reduce((s, tag) => s + (t.includes(tag) ? 2 : 0), 0) + (ic.name === fallback ? 3 : 0),
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.name);
  const out = [fallback, ...scored].filter((v, i, a) => a.indexOf(v) === i);
  for (const ic of ['sparkles', 'star', 'zap', 'target', 'heart', 'compass']) if (!out.includes(ic)) out.push(ic);
  return out.slice(0, 8);
}

// ───────────────────────── Cities (for location tags + store map) ─────────────────────────
export interface City {
  city: string;
  region: string;
  lat: number;
  lng: number;
}

export const CITIES: City[] = [
  { city: 'New York', region: 'NY', lat: 40.71, lng: -74.01 },
  { city: 'Brooklyn', region: 'NY', lat: 40.68, lng: -73.94 },
  { city: 'Los Angeles', region: 'CA', lat: 34.05, lng: -118.24 },
  { city: 'Chicago', region: 'IL', lat: 41.88, lng: -87.63 },
  { city: 'Houston', region: 'TX', lat: 29.76, lng: -95.37 },
  { city: 'Phoenix', region: 'AZ', lat: 33.45, lng: -112.07 },
  { city: 'Philadelphia', region: 'PA', lat: 39.95, lng: -75.17 },
  { city: 'San Antonio', region: 'TX', lat: 29.42, lng: -98.49 },
  { city: 'San Diego', region: 'CA', lat: 32.72, lng: -117.16 },
  { city: 'Dallas', region: 'TX', lat: 32.78, lng: -96.8 },
  { city: 'Austin', region: 'TX', lat: 30.27, lng: -97.74 },
  { city: 'Jacksonville', region: 'FL', lat: 30.33, lng: -81.66 },
  { city: 'San Jose', region: 'CA', lat: 37.34, lng: -121.89 },
  { city: 'Columbus', region: 'OH', lat: 39.96, lng: -83.0 },
  { city: 'Charlotte', region: 'NC', lat: 35.23, lng: -80.84 },
  { city: 'Indianapolis', region: 'IN', lat: 39.77, lng: -86.16 },
  { city: 'San Francisco', region: 'CA', lat: 37.77, lng: -122.42 },
  { city: 'Seattle', region: 'WA', lat: 47.61, lng: -122.33 },
  { city: 'Denver', region: 'CO', lat: 39.74, lng: -104.99 },
  { city: 'Nashville', region: 'TN', lat: 36.16, lng: -86.78 },
  { city: 'Washington', region: 'DC', lat: 38.91, lng: -77.04 },
  { city: 'Boston', region: 'MA', lat: 42.36, lng: -71.06 },
  { city: 'Las Vegas', region: 'NV', lat: 36.17, lng: -115.14 },
  { city: 'Portland', region: 'OR', lat: 45.52, lng: -122.68 },
  { city: 'Detroit', region: 'MI', lat: 42.33, lng: -83.05 },
  { city: 'Memphis', region: 'TN', lat: 35.15, lng: -90.05 },
  { city: 'Louisville', region: 'KY', lat: 38.25, lng: -85.76 },
  { city: 'Baltimore', region: 'MD', lat: 39.29, lng: -76.61 },
  { city: 'Milwaukee', region: 'WI', lat: 43.04, lng: -87.91 },
  { city: 'Albuquerque', region: 'NM', lat: 35.08, lng: -106.65 },
  { city: 'Tucson', region: 'AZ', lat: 32.22, lng: -110.97 },
  { city: 'Sacramento', region: 'CA', lat: 38.58, lng: -121.49 },
  { city: 'Kansas City', region: 'MO', lat: 39.1, lng: -94.58 },
  { city: 'Atlanta', region: 'GA', lat: 33.75, lng: -84.39 },
  { city: 'Miami', region: 'FL', lat: 25.76, lng: -80.19 },
  { city: 'Raleigh', region: 'NC', lat: 35.78, lng: -78.64 },
  { city: 'Minneapolis', region: 'MN', lat: 44.98, lng: -93.27 },
  { city: 'Tampa', region: 'FL', lat: 27.95, lng: -82.46 },
  { city: 'New Orleans', region: 'LA', lat: 29.95, lng: -90.07 },
  { city: 'Cleveland', region: 'OH', lat: 41.5, lng: -81.69 },
  { city: 'Pittsburgh', region: 'PA', lat: 40.44, lng: -79.99 },
  { city: 'Salt Lake City', region: 'UT', lat: 40.76, lng: -111.89 },
  { city: 'Orlando', region: 'FL', lat: 28.54, lng: -81.38 },
  { city: 'St. Louis', region: 'MO', lat: 38.63, lng: -90.2 },
  { city: 'Boise', region: 'ID', lat: 43.62, lng: -116.21 },
  { city: 'Richmond', region: 'VA', lat: 37.54, lng: -77.44 },
  { city: 'Charleston', region: 'SC', lat: 32.78, lng: -79.93 },
  { city: 'Savannah', region: 'GA', lat: 32.08, lng: -81.09 },
  { city: 'Asheville', region: 'NC', lat: 35.6, lng: -82.55 },
  { city: 'Omaha', region: 'NE', lat: 41.26, lng: -95.93 },
  { city: 'Oklahoma City', region: 'OK', lat: 35.47, lng: -97.52 },
  { city: 'Spokane', region: 'WA', lat: 47.66, lng: -117.43 },
  { city: 'Burlington', region: 'VT', lat: 44.48, lng: -73.21 },
  { city: 'Portland', region: 'ME', lat: 43.66, lng: -70.26 },
  { city: 'Toronto', region: 'ON', lat: 43.65, lng: -79.38 },
  { city: 'Vancouver', region: 'BC', lat: 49.28, lng: -123.12 },
];

export function findCity(text: string): City | null {
  const t = (text || '').toLowerCase().trim();
  if (!t) return null;
  const [cityPart, regionPart] = t.split(',').map((s) => s.trim());
  return (
    CITIES.find((c) => c.city.toLowerCase() === cityPart && (!regionPart || c.region.toLowerCase() === regionPart)) ||
    CITIES.find((c) => c.city.toLowerCase() === cityPart) ||
    CITIES.find((c) => c.city.toLowerCase().startsWith(cityPart)) ||
    null
  );
}

export function distanceMi(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
