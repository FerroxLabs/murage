// The Windows driver pins Murage runs (DESIGN 1022-cua-windows D1, D5, D6). Owner: the Windows builder lane
// (build-1022-cua-windows). The release record is scripts/cua-driver-0.55.0-windows-provenance.json; a test pins
// these constants equal to it, so a pin bump moves both.
export const WINDOWS_DRIVER_VERSION = "0.55.0";
export const WINDOWS_DRIVER_CONTRACT_VERSION = "0.9.0";
export const WINDOWS_DRIVER_SHA256 = "4a14438f4ee8ef768da6f4cdcae2403b2e58e78952f3d323cc7ba9615539ed2b";
export const WINDOWS_CURSOR_SHA256 = "b8565863057f5471c939f65ef0afb9154829c8da0e09c42fcddba8dfbabd7604";
