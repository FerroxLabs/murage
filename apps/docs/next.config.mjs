import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The `Mobile` section became `Devices` when the iOS companion was retired.
  // `Mobile` held two pages that meant opposite things — a phone controlling
  // Murage, and Murage controlling a USB-attached phone. Only the second one
  // survived, and `Devices` is what that page was always about.
  //
  // These are permanent because the old URLs were published: `/docs/mobile/*`
  // is in search indexes and in anything anyone bookmarked. `ios-companion`
  // has no successor page, so it lands on the section index rather than
  // pretending an equivalent exists; the roadmap answer for reaching bots
  // from a phone lives on the docs home page.
  async redirects() {
    return [
      {
        source: '/docs/mobile/ios-companion',
        destination: '/docs/devices',
        permanent: true,
      },
      {
        source: '/docs/mobile/:slug*',
        destination: '/docs/devices/:slug*',
        permanent: true,
      },
      {
        source: '/docs/mobile',
        destination: '/docs/devices',
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
