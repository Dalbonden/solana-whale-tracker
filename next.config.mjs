/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.pump.fun' },
      { protocol: 'https', hostname: 'ipfs.io' },
      { protocol: 'https', hostname: '**.ipfs.nftstorage.link' },
      { protocol: 'https', hostname: 'arweave.net' },
      { protocol: 'https', hostname: '**.arweave.net' },
      { protocol: 'https', hostname: 'raw.githubusercontent.com' },
      { protocol: 'https', hostname: 'img.fotofolio.xyz' },
      { protocol: 'https', hostname: '**.birdeye.so' },
      { protocol: 'https', hostname: 'cdn.jsdelivr.net' },
    ],
  },
  eslint: {
    // Type errors still fail the build; lint noise should not block deploys.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
