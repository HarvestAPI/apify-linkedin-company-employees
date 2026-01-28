import { ApiPagination, Profile, ProfileShort } from '@harvestapi/scraper';
import { Actor } from 'apify';
import { ProfileScraperMode } from '../main.js';

export const pushItem = async ({
  item,
  payments,
  pagination,
  profileScraperMode,
  query,
}: {
  item: Profile | ProfileShort;
  payments: string[];
  pagination: ApiPagination | null;
  profileScraperMode: ProfileScraperMode;
  query: Record<string, any>;
}) => {
  console.info(`Scraped profile ${item.linkedinUrl || item?.publicIdentifier || item?.id}`);
  let pushResult: { eventChargeLimitReached: boolean } | null = null;

  item = {
    ...item,
    _meta: {
      pagination,
      query,
    },
  } as (Profile | ProfileShort) & {
    _meta: {
      pagination: ApiPagination | null;
      query: Record<string, any>;
    };
  };

  if (profileScraperMode === ProfileScraperMode.SHORT) {
    pushResult = await Actor.pushData(item, 'short-profile');
  }
  if (profileScraperMode === ProfileScraperMode.FULL) {
    pushResult = await Actor.pushData(item, 'full-profile');
  }
  if (profileScraperMode === ProfileScraperMode.EMAIL) {
    if ((payments || []).includes('linkedinProfileWithEmail')) {
      pushResult = await Actor.pushData(item, 'full-profile-with-email');
    } else {
      pushResult = await Actor.pushData(item, 'full-profile');
    }
  }

  if (pushResult?.eventChargeLimitReached) {
    await Actor.exit({
      statusMessage: 'max charge reached',
    });
  }
};
