#!/usr/bin/env python3
"""Adds the NotificationService extension target to App.xcodeproj (Plan 3b I1).
Run once from the repo root; it refuses to run twice. IDs use the ABCDEF40 range.

Already applied (the target is in project.pbxproj). Kept only as the record of
how the NotificationService target was added; there is no reason to run it again."""
import pathlib

p = pathlib.Path("apps/mobile/ios/App/App.xcodeproj/project.pbxproj")
s = p.read_text()
assert "NotificationService.appex" not in s, "already applied"
I = lambda n: f"ABCDEF4000000000000000{n:02X}"
APP_TARGET, PROJECT, MAIN_GROUP, PRODUCTS, APP_GROUP = "504EC3031FED79650016851F", "504EC2FC1FED79650016851F", "504EC2FB1FED79650016851F", "504EC3051FED79650016851F", "504EC3061FED79650016851F"
SHELL_PACKAGE = "ABCDEF300000000000000003"

def after(marker: str, text: str) -> None:
    global s
    at = s.index(marker) + len(marker)
    s = s[:at] + text + s[at:]

after("/* Begin PBXBuildFile section */\n",
      f"\t\t{I(0x11)} /* NotificationService.swift in Sources */ = {{isa = PBXBuildFile; fileRef = {I(0x01)} /* NotificationService.swift */; }};\n"
      f"\t\t{I(0x12)} /* MurageShellCore in Frameworks */ = {{isa = PBXBuildFile; productRef = {I(0x22)} /* MurageShellCore */; }};\n"
      f"\t\t{I(0x13)} /* NotificationService.appex in Embed Foundation Extensions */ = {{isa = PBXBuildFile; fileRef = {I(0x05)} /* NotificationService.appex */; settings = {{ATTRIBUTES = (RemoveHeadersOnCopy, ); }}; }};\n")

after("/* End PBXBuildFile section */\n",
      "\n/* Begin PBXContainerItemProxy section */\n"
      f"\t\t{I(0x48)} /* PBXContainerItemProxy */ = {{\n\t\t\tisa = PBXContainerItemProxy;\n\t\t\tcontainerPortal = {PROJECT} /* Project object */;\n"
      f"\t\t\tproxyType = 1;\n\t\t\tremoteGlobalIDString = {I(0x41)};\n\t\t\tremoteInfo = NotificationService;\n\t\t}};\n"
      "/* End PBXContainerItemProxy section */\n\n/* Begin PBXCopyFilesBuildPhase section */\n"
      f"\t\t{I(0x46)} /* Embed Foundation Extensions */ = {{\n\t\t\tisa = PBXCopyFilesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tdstPath = \"\";\n"
      f"\t\t\tdstSubfolderSpec = 13;\n\t\t\tfiles = (\n\t\t\t\t{I(0x13)} /* NotificationService.appex in Embed Foundation Extensions */,\n\t\t\t);\n"
      "\t\t\tname = \"Embed Foundation Extensions\";\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};\n/* End PBXCopyFilesBuildPhase section */\n")

after("/* Begin PBXFileReference section */\n",
      f"\t\t{I(0x01)} /* NotificationService.swift */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = NotificationService.swift; sourceTree = \"<group>\"; }};\n"
      f"\t\t{I(0x02)} /* Info.plist */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = \"<group>\"; }};\n"
      f"\t\t{I(0x03)} /* NotificationService.entitlements */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = NotificationService.entitlements; sourceTree = \"<group>\"; }};\n"
      f"\t\t{I(0x04)} /* App.entitlements */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = App.entitlements; sourceTree = \"<group>\"; }};\n"
      f"\t\t{I(0x05)} /* NotificationService.appex */ = {{isa = PBXFileReference; explicitFileType = \"wrapper.app-extension\"; includeInIndex = 0; path = NotificationService.appex; sourceTree = BUILT_PRODUCTS_DIR; }};\n")

after("/* Begin PBXFrameworksBuildPhase section */\n",
      f"\t\t{I(0x44)} /* Frameworks */ = {{\n\t\t\tisa = PBXFrameworksBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n"
      f"\t\t\t\t{I(0x12)} /* MurageShellCore in Frameworks */,\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t}};\n")

after("/* Begin PBXGroup section */\n",
      f"\t\t{I(0x31)} /* NotificationService */ = {{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t{I(0x01)} /* NotificationService.swift */,\n"
      f"\t\t\t\t{I(0x02)} /* Info.plist */,\n\t\t\t\t{I(0x03)} /* NotificationService.entitlements */,\n\t\t\t);\n\t\t\tpath = NotificationService;\n\t\t\tsourceTree = \"<group>\";\n\t\t}};\n")
after(f"{MAIN_GROUP} = {{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n", f"\t\t\t\t{I(0x31)} /* NotificationService */,\n")
after(f"{PRODUCTS} /* Products */ = {{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n", f"\t\t\t\t{I(0x05)} /* NotificationService.appex */,\n")
after(f"{APP_GROUP} /* App */ = {{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n", f"\t\t\t\t{I(0x04)} /* App.entitlements */,\n")

after("/* Begin PBXNativeTarget section */\n",
      f"\t\t{I(0x41)} /* NotificationService */ = {{\n\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = {I(0x42)} /* Build configuration list for PBXNativeTarget \"NotificationService\" */;\n"
      f"\t\t\tbuildPhases = (\n\t\t\t\t{I(0x43)} /* Sources */,\n\t\t\t\t{I(0x44)} /* Frameworks */,\n\t\t\t\t{I(0x45)} /* Resources */,\n\t\t\t);\n"
      "\t\t\tbuildRules = (\n\t\t\t);\n\t\t\tdependencies = (\n\t\t\t);\n\t\t\tname = NotificationService;\n"
      f"\t\t\tpackageProductDependencies = (\n\t\t\t\t{I(0x22)} /* MurageShellCore */,\n\t\t\t);\n\t\t\tproductName = NotificationService;\n"
      f"\t\t\tproductReference = {I(0x05)} /* NotificationService.appex */;\n\t\t\tproductType = \"com.apple.product-type.app-extension\";\n\t\t}};\n")
# The app embeds and depends on it.
after(f"\t\t\t\t504EC3021FED79650016851F /* Resources */,\n", f"\t\t\t\t{I(0x46)} /* Embed Foundation Extensions */,\n")
after(f"{APP_TARGET} /* App */ = {{", "")
app_deps = s.index("dependencies = (\n", s.index(f"{APP_TARGET} /* App */ = {{\n\t\t\tisa = PBXNativeTarget;"))
s = s[:app_deps + len("dependencies = (\n")] + f"\t\t\t\t{I(0x47)} /* PBXTargetDependency */,\n" + s[app_deps + len("dependencies = (\n"):]

after("\t\t\ttargets = (\n\t\t\t\t504EC3031FED79650016851F /* App */,\n", f"\t\t\t\t{I(0x41)} /* NotificationService */,\n")
after("\t\t\t\tTargetAttributes = {\n", f"\t\t\t\t\t{I(0x41)} = {{\n\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;\n\t\t\t\t\t}};\n")

after("/* Begin PBXResourcesBuildPhase section */\n",
      f"\t\t{I(0x45)} /* Resources */ = {{\n\t\t\tisa = PBXResourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t}};\n")
after("/* Begin PBXSourcesBuildPhase section */\n",
      f"\t\t{I(0x43)} /* Sources */ = {{\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n"
      f"\t\t\t\t{I(0x11)} /* NotificationService.swift in Sources */,\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t}};\n")
after("/* End PBXSourcesBuildPhase section */\n",
      "\n/* Begin PBXTargetDependency section */\n"
      f"\t\t{I(0x47)} /* PBXTargetDependency */ = {{\n\t\t\tisa = PBXTargetDependency;\n\t\t\ttarget = {I(0x41)} /* NotificationService */;\n"
      f"\t\t\ttargetProxy = {I(0x48)} /* PBXContainerItemProxy */;\n\t\t}};\n/* End PBXTargetDependency section */\n")

def nse_config(ident: int, name: str, debug: bool) -> str:
    extra = "\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;\n" if debug else ""
    return (f"\t\t{I(ident)} /* {name} */ = {{\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {{\n"
            "\t\t\t\tAPPLICATION_EXTENSION_API_ONLY = YES;\n"
            "\t\t\t\tCODE_SIGN_ENTITLEMENTS = NotificationService/NotificationService.entitlements;\n\t\t\t\tCODE_SIGN_STYLE = Automatic;\n"
            "\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tINFOPLIST_FILE = NotificationService/Info.plist;\n\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;\n"
            "\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (\n\t\t\t\t\t\"$(inherited)\",\n\t\t\t\t\t\"@executable_path/Frameworks\",\n\t\t\t\t\t\"@executable_path/../../Frameworks\",\n\t\t\t\t);\n"
            "\t\t\t\tMARKETING_VERSION = 1.0;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.murage.mobile.NotificationService;\n\t\t\t\tPRODUCT_NAME = \"$(TARGET_NAME)\";\n"
            f"\t\t\t\tSKIP_INSTALL = YES;\n{extra}\t\t\t\tSWIFT_VERSION = 5.0;\n\t\t\t\tTARGETED_DEVICE_FAMILY = \"1,2\";\n\t\t\t}};\n\t\t\tname = {name};\n\t\t}};\n")
after("/* Begin XCBuildConfiguration section */\n", nse_config(0x49, "Debug", True) + nse_config(0x4A, "Release", False))
after("/* Begin XCConfigurationList section */\n",
      f"\t\t{I(0x42)} /* Build configuration list for PBXNativeTarget \"NotificationService\" */ = {{\n\t\t\tisa = XCConfigurationList;\n\t\t\tbuildConfigurations = (\n"
      f"\t\t\t\t{I(0x49)} /* Debug */,\n\t\t\t\t{I(0x4A)} /* Release */,\n\t\t\t);\n\t\t\tdefaultConfigurationIsVisible = 0;\n\t\t\tdefaultConfigurationName = Release;\n\t\t}};\n")
after("/* Begin XCSwiftPackageProductDependency section */\n",
      f"\t\t{I(0x22)} /* MurageShellCore */ = {{\n\t\t\tisa = XCSwiftPackageProductDependency;\n\t\t\tpackage = {SHELL_PACKAGE} /* XCLocalSwiftPackageReference \"MurageShell\" */;\n\t\t\tproductName = MurageShellCore;\n\t\t}};\n")

# The app's two configurations: its entitlements and the two environments.
for ident, env in (("504EC3171FED79650016851F", "development"), ("504EC3181FED79650016851F", "production")):
    block = s.index(f"{ident} /* ")
    settings = s.index("buildSettings = {\n", block) + len("buildSettings = {\n")
    s = s[:settings] + (f"\t\t\t\tAPP_ATTEST_ENVIRONMENT = {env};\n\t\t\t\tAPS_ENVIRONMENT = {env};\n"
                        "\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n") + s[settings:]

p.write_text(s)
print("NotificationService target added")
