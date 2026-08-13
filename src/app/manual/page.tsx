import type { Metadata } from 'next';

import { ManualView } from '@/components/ManualView';

export const metadata: Metadata = {
  title: 'Reported balances',
  description:
    'Balances you report yourself — exchange accounts and cold storage — priced at market, never verified.',
};

export default function ManualPage() {
  return <ManualView />;
}
