// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/).
import {
  ApiItemResponse,
  createLinkedinScraper,
  Profile,
  SearchLinkedInSalesNavLeadsParams,
} from '@harvestapi/scraper';
import { Actor } from 'apify';
import { config } from 'dotenv';
import { styleText } from 'node:util';
import { pushItem } from './utils/pushItem.js';

config();

// The init() call configures the Actor for its environment. It's recommended to start every Actor with an init().
await Actor.init();

export enum ProfileScraperMode {
  SHORT,
  FULL,
  EMAIL,
}

const profileScraperModeInputMap1: Record<string, ProfileScraperMode> = {
  'Short ($4 per 1k)': ProfileScraperMode.SHORT,
  'Full ($8 per 1k)': ProfileScraperMode.FULL,
  'Full + email search ($12 per 1k)': ProfileScraperMode.EMAIL,
};
const profileScraperModeInputMap2: Record<string, ProfileScraperMode> = {
  '1': ProfileScraperMode.SHORT,
  '2': ProfileScraperMode.FULL,
  '3': ProfileScraperMode.EMAIL,
};

interface Input {
  profileScraperMode: string;
  companies?: string[];
  locations?: string[];
  maxItems?: number;
  searchQuery?: string;
  jobTitles?: string[];
  startPage?: number;
  takePages?: number;
  industryIds?: string[];
  yearsAtCurrentCompanyIds?: string[];
  companyBatchMode?: 'all_at_once' | 'one_by_one';
}

// Structure of input is defined in input_schema.json
const input = await Actor.getInput<Input>();
if (!input) throw new Error('Input is missing!');

const profileScraperMode =
  profileScraperModeInputMap1[input.profileScraperMode] ??
  profileScraperModeInputMap2[input.profileScraperMode] ??
  ProfileScraperMode.FULL;

const query: {
  companies: string[];
  location: string[];
  currentJobTitles: string[];
  industryIds: string[];
  yearsAtCurrentCompanyIds: string[];
  search: string;
} = {
  companies: input.companies || [],
  location: input.locations || [],
  search: input.searchQuery || '',
  currentJobTitles: input.jobTitles || [],
  industryIds: input.industryIds || [],
  yearsAtCurrentCompanyIds: input.yearsAtCurrentCompanyIds || [],
};

for (const key of Object.keys(query) as (keyof typeof query)[]) {
  if (Array.isArray(query[key]) && query[key].length) {
    (query[key] as string[]) = query[key]
      .map((v) => (v || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((v) => v && v.length);
  }
}

if (!input.companies?.length) {
  console.error('Please provide at least one company.');
  await Actor.exit({
    statusMessage: 'no companies',
  });
}

const { actorId, actorRunId, actorBuildId, userId, actorMaxPaidDatasetItems, memoryMbytes } =
  Actor.getEnv();
const client = Actor.newClient();

const user = userId ? await client.user(userId).get() : null;
const cm = Actor.getChargingManager();
const pricingInfo = cm.getPricingInfo();
const isPaying = (user as Record<string, any> | null)?.isPaying === false ? false : true;
const runCounterStore = await Actor.openKeyValueStore('run-counter-store');

if (pricingInfo.maxTotalChargeUsd < 0.03) {
  console.warn(
    'Warning: The maximum total charge is set to less than $0.03, which will not be sufficient for scraping LinkedIn profiles.',
  );
  await Actor.exit({
    statusMessage: 'max charge reached',
  });
}

let totalRuns = 0;
if (userId) {
  if (!isPaying) {
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 4000));
  }
  totalRuns = Number(await runCounterStore.getValue(userId)) || 0;
  totalRuns++;
  await runCounterStore.setValue(userId, totalRuns);
}

const state: {
  leftItems: number;
  processedCompanies: string[];
  queryScrapedPages: Record<string, number>;
  queryChargedActorStart: Record<string, boolean>;
} = (await Actor.getValue('crawling-state')) || {
  leftItems: actorMaxPaidDatasetItems || 1000000,
  processedCompanies: [],
  queryScrapedPages: {},
  queryChargedActorStart: {},
};
if (input.maxItems && input.maxItems < state.leftItems) {
  state.leftItems = input.maxItems;
}

let freeUserItemsLimit = 25;
if (profileScraperMode === ProfileScraperMode.EMAIL) {
  freeUserItemsLimit = 10;
}

let isFreeUserExceeding = false;
const logFreeUserExceeding = () =>
  console.warn(
    styleText('bgYellow', ' [WARNING] ') +
      ` Free users are limited up to ${freeUserItemsLimit} items per run. Please upgrade to a paid plan to scrape more items.`,
  );

if (!isPaying) {
  if (totalRuns > 10) {
    console.warn(
      styleText('bgYellow', ' [WARNING] ') +
        ' Free users are limited to 10 runs. Please upgrade to a paid plan to run more.',
    );
    await Actor.exit({
      statusMessage: 'free user run limit exceeded',
    });
  }

  if (state.leftItems > freeUserItemsLimit) {
    isFreeUserExceeding = true;
    state.leftItems = freeUserItemsLimit;
    logFreeUserExceeding();
  }
}

const scraper = createLinkedinScraper({
  apiKey: process.env.HARVESTAPI_TOKEN!,
  baseUrl: process.env.HARVESTAPI_URL || 'https://api.harvest-api.com',
  addHeaders: {
    'x-apify-userid': userId!,
    'x-apify-actor-id': actorId!,
    'x-apify-actor-run-id': actorRunId!,
    'x-apify-actor-build-id': actorBuildId!,
    'x-apify-memory-mbytes': String(memoryMbytes),
    'x-apify-actor-max-paid-dataset-items': String(actorMaxPaidDatasetItems) || '0',
    'x-apify-username': user?.username || '',
    'x-apify-user-is-paying': (user as Record<string, any> | null)?.isPaying,
    'x-apify-user-is-paying2': String(isPaying),
    'x-apify-max-total-charge-usd': String(pricingInfo.maxTotalChargeUsd),
    'x-apify-is-pay-per-event': String(pricingInfo.isPayPerEvent),
    'x-apify-user-runs': String(totalRuns),
    'x-apify-user-left-items': String(state.leftItems),
    'x-apify-user-max-items': String(input.maxItems),
  },
});

const itemQuery = {
  ...query,
};
for (const key of Object.keys(itemQuery) as (keyof typeof itemQuery)[]) {
  if (!itemQuery[key]) {
    delete itemQuery[key];
  }
  if (Array.isArray(itemQuery[key])) {
    if (!itemQuery[key].length) {
      delete itemQuery[key];
    }
  }
}

if (!Object.keys(itemQuery).length) {
  console.warn(
    'Please provide at least one search query or filter. Nothing to search, skipping...',
  );
  await Actor.exit({
    statusMessage: 'no search query',
  });
}

Actor.on('migrating', async () => {
  await Actor.setValue('crawling-state', state);
  await Actor.reboot();
});

let hitRateLimit = false;

async function runScraper(scraperQuery: SearchLinkedInSalesNavLeadsParams) {
  const currentCompaniesArray = Array.isArray(scraperQuery.currentCompanies)
    ? scraperQuery.currentCompanies
    : [scraperQuery.currentCompanies];
  const currentCompaniesKey = currentCompaniesArray.join(',') || 'all';

  const previousScrapedPage = state.queryScrapedPages[currentCompaniesKey] || 0;

  console.info(
    `Starting scraping LinkedIn Sales Navigator leads for query: ${JSON.stringify(scraperQuery)}`,
  );
  await scraper.scrapeSalesNavigatorLeads({
    query: scraperQuery,
    maxItems: state.leftItems,
    findEmail: profileScraperMode === ProfileScraperMode.EMAIL,
    outputType: 'callback',
    disableLog: true,
    overrideConcurrency: profileScraperMode === ProfileScraperMode.EMAIL ? 10 : 8,
    overridePageConcurrency: state.leftItems > 200 ? 2 : 1,
    warnPageLimit: isPaying,
    startPage: input!.startPage || previousScrapedPage || 1,
    takePages: isPaying ? input!.takePages : 1,
    onItemScraped: async ({ item, payments, pagination }) => {
      return pushItem({ item, payments: payments || [], pagination, profileScraperMode });
    },
    optionsOverride: {
      fetchItem: async ({ item }) => {
        if (item?.id || item?.publicIdentifier) {
          state.leftItems -= 1;
          if (state.leftItems < 0) {
            return { skipped: true, done: true };
          }

          if (profileScraperMode === ProfileScraperMode.SHORT && item?.id) {
            return {
              status: 200,
              entityId: item.id || item.publicIdentifier,
              element: item,
            } as ApiItemResponse<Profile>;
          }

          return scraper.getProfile({
            url: `https://www.linkedin.com/in/${item.publicIdentifier || item.id}`,
            findEmail: profileScraperMode === ProfileScraperMode.EMAIL,
          });
        }

        return { skipped: true };
      },
    },
    onPageFetched: async ({ page, data }) => {
      if (page === 1) {
        if (data?.status === 429) {
          console.error('Too many requests');
        } else if (data?.pagination) {
          if (!state.queryChargedActorStart[currentCompaniesKey]) {
            state.queryChargedActorStart[currentCompaniesKey] = true;
            const pushResult = await Actor.charge({ eventName: 'actor-start' });
            if (pushResult.eventChargeLimitReached) {
              await Actor.exit({
                statusMessage: 'max charge reached',
              });
            }
            await Actor.setValue('crawling-state', state);
          }

          console.info(
            `Found ${data.pagination.totalElements} profiles total for input ${JSON.stringify(scraperQuery)}`,
          );
        }

        if (typeof data?.error === 'string' && data.error.includes('No available resource')) {
          hitRateLimit = true;
          console.error(
            `We've hit LinkedIn rate limits due to the active usage from our Apify users. Rate limits reset hourly. Please continue at the beginning of the next hour.`,
          );
        }
      }
      if (data?.elements?.length) {
        state.queryScrapedPages[currentCompaniesKey] = page;
        await Actor.setValue('crawling-state', state);
      }
      console.info(
        `Scraped search page ${page}. Found ${data?.elements?.length} profiles on the page.`,
      );
    },
    addListingHeaders: {
      'x-sub-user': user?.username || '',
      'x-concurrency': user?.username ? '1' : (undefined as any),
      'x-request-timeout': '360',
      'x-queue-size': isPaying ? '30' : '5',
    },
  });
}

if (input.companyBatchMode === 'one_by_one') {
  for (const company of itemQuery.companies || []) {
    if (state.processedCompanies.includes(company)) {
      continue;
    }

    const companyQuery: SearchLinkedInSalesNavLeadsParams = {
      ...itemQuery,
      currentCompanies: [company],
    };
    delete (companyQuery as any).companies;
    await runScraper(companyQuery);

    if (!hitRateLimit) {
      state.processedCompanies.push(company);
    }
    await Actor.setValue('crawling-state', state);

    if (state.leftItems <= 0) break;
    if (hitRateLimit) break;
  }
} else {
  if (input.companies && input.companies.length > 20) {
    console.warn(
      styleText('bgYellow', ' [WARNING] ') +
        'You can provide up to 20 companies when using "All at once" mode. To process more companies, please switch to "One by one" mode. Note: "One by one" will charge Actor start event ($0.02) for each company.',
    );
    await Actor.exit({
      statusMessage: 'up to 20 companies',
    });
  }

  const companyQuery: SearchLinkedInSalesNavLeadsParams = {
    ...itemQuery,
    currentCompanies: input.companies || [],
  };
  delete (companyQuery as any).companies;
  await runScraper(companyQuery);
}

if (isFreeUserExceeding) {
  logFreeUserExceeding();
}

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit().
await new Promise((resolve) => setTimeout(resolve, 1000));
await Actor.exit({
  statusMessage: hitRateLimit ? 'rate limited' : 'success',
});
// process.exit(0);
