import { ExecFileException, ExecFileOptionsWithOtherEncoding } from "child_process";
import { IncomingMessage } from "http";
import { exit } from "process";

/*
 * IMPORTANT: Only modify action.ts. Any modifications to action.js will be lost.
 */

// NodeJS modules we will need
const  os = require("os"),
       fs = require("fs"),
     path = require("path"),
     util = require('util'),
    https = require("https"),
 execFile = require("child_process").execFile,
 validUrl = require('valid-url');

/* Structure returned from NUGET_SOURCE/v3-flatcontainer/PACKAGE_NAME/index.json */
interface IPackageVersions {
    versions: string[];
}

class Action {
    private _projectFilePath: string;
    private _nugetSearchPath: string;
    private _nugetKey: string;
    private _nugetSource: string;
    private _packageName: string;
    private _packageVersion: string;
    private _includeSymbols: boolean;
    private _tagCommit: boolean;
    private _tagFormat: string;
    private _rebuildProject: boolean;
    private _debug: boolean;
    private _versionFilePath: string;
    private _versionRegex: string;

    constructor() {
        this._projectFilePath = process.env.INPUT_PROJECT_FILE_PATH || process.env.PROJECT_FILE_PATH;
        this._nugetKey = process.env.INPUT_NUGET_KEY || process.env.NUGET_KEY;
        this._nugetSource = process.env.INPUT_NUGET_SOURCE || process.env.NUGET_SOURCE;
        this._tagFormat = process.env.INPUT_TAG_FORMAT || process.env.TAG_FORMAT;
        this._packageName = process.env.INPUT_PACKAGE_NAME || process.env.PACKAGE_NAME;
        this._packageVersion = process.env.INPUT_VERSION_STATIC || process.env.VERSION_STATIC;
        this._versionFilePath = process.env.INPUT_VERSION_FILE_PATH || process.env.VERSION_FILE_PATH;
        this._versionRegex = process.env.INPUT_VERSION_REGEX || process.env.VERSION_REGEX;
        let key: string;
        let value: string;
        try {
            key = "INCLUDE_SYMBOLS"; value = process.env.INPUT_INCLUDE_SYMBOLS || process.env.INCLUDE_SYMBOLS || "false";
            this._includeSymbols = JSON.parse(value);
            key = "TAG_COMMIT"; value = process.env.INPUT_TAG_COMMIT || process.env.TAG_COMMIT || "false";
            this._tagCommit = JSON.parse(value);
            key = "REBUILD_PROJECT"; value = process.env.INPUT_REBUILD_PROJECT || process.env.REBUILD_PROJECT || "true";
            this._rebuildProject = JSON.parse(value);
            key = "DEBUG"; value = process.env.INPUT_DEBUG || process.env.DEBUG || "true";
            this._debug = JSON.parse(value);
        } catch (error) { 
            this.fail(`Error parsing variable "${key}" value "${value}": ${error}`);
        }
    }

    /* Main entry point */
    public async run(): Promise<void> {
        // Validate input variables and populate variables if necessary
        this.validateAndPopulateInputs();
        
        // Check if package exists on NuGet server.
        const nugetPackageExists = await this.checkNugetPackageExistsAsync(this._packageName, this._packageVersion);
        this.info(`NuGet package "${this._packageName}" version "${this._packageVersion}" does${nugetPackageExists?"":" not"} exists on NuGet server "${this._nugetSource}".`);
        
        // If package does exist we will stop here.
        if (nugetPackageExists) {
            this.info("Will not publish NuGet package because this version already exists on NuGet server.");
            return;
        }

        // Rebuild project if specified
        if (this._rebuildProject)
           await this.rebuildProjectAsync();

        // Package project
        await this.packageProjectAsync();

        // Publish package
        await this.publishPackageAsync();

        // Commit a tag if publish was successful
        if (this._tagCommit)
            await this.gitCommitTagAsync;
    }

    private fail(message: string|any, ...optionalParameters: any[]): void {
        console.error("ERROR: " + message, optionalParameters);
        throw new Error(message);
    }

    private info(message: string|any, ...optionalParameters: any[]): void {
        console.log(message, optionalParameters);
    }

    private debug(message: string|any, ...optionalParameters: any[]): void {
        if (this._debug)
            console.debug(message, optionalParameters);
    }

    private outputVariable(name: string, value: any): void {
        process.stdout.write(`::set-output name=${name}::${value}${os.EOL}`)
    }

    private async executeAsync(command: string, args: string[] = [], logSafeArgs: string[] = null, options: ExecFileOptionsWithOtherEncoding = null): Promise<void> {
        if (logSafeArgs === null)
            logSafeArgs = args;
        this.info(`[executeAsync] Executing command: ${command} ${logSafeArgs.join(" ")}`);
        
        options = options || <ExecFileOptionsWithOtherEncoding>{};
        //options.stdio = [process.stdin, process.stdout, process.stderr];
        const asyncExe = util.promisify(execFile);
        const result = await asyncExe(execFile(command, args, options, (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
            if (error)
                this.fail(error);

            if (stderr)
                process.stderr.write(stderr);
            
            if (stdout) 
                process.stdout.write(stdout);
        }));
    }

    /**
     * Validates the user inputs from GitHub Actions
     */
    private validateAndPopulateInputs() {
        // Check that we have a valid project file path
        !fs.existsSync(this._projectFilePath)         && this.fail(`Project path "${this._projectFilePath}" does not exist.`);
        !fs.lstatSync(this._projectFilePath).isFile() && this.fail(`Project path "${this._projectFilePath}" must be a directory.`);
        this.debug(`Project path exists: ${this._projectFilePath}`);

        // Check that we have a valid nuget key
        !this._nugetKey                        && this.fail(`Nuget key must be specified.`);

        // Check that we have a valid nuget source
        !validUrl.isUri(this._nugetSource)     && this.fail(`Nuget source "${this._nugetSource}" is not a valid URL.`);

        // If we don't have a static package version we'll need to look it up
        if (!this._packageVersion) {
            // Check that we have a valid version file path
            !fs.existsSync(this._versionFilePath)         && this.fail(`Version file path "${this._versionFilePath}" does not exist.`);
            !fs.lstatSync(this._versionFilePath).isFile() && this.fail(`Version file path "${this._versionFilePath}" must be a directory.`);
            this.debug(`Version file path exists: ${this._versionFilePath}`);
            
            // Check that regex is correct
            let versionRegex: RegExp;
            try {
                versionRegex = new RegExp(this._versionRegex, "m");
            } catch(e) {
                this.fail(`Version regex "${this._versionRegex}" is not a valid regular expression: ${e.message}`);
            }

            // Read file content
            const versionFileContent = fs.readFileSync(this._versionFilePath);
            const version = versionRegex.exec(versionFileContent)

            if (!version)
                this.fail(`Unable to find version using regex "${this._versionRegex}" in file "${this._versionFilePath}".`);
            
            // Successfully read version
            this._packageVersion = version[1];
        }

        // Check that we have a valid tag format
        if (this._tagCommit) {
            !this._tagFormat                   && this.fail(`Tag format must be specified.`);
            !this._tagFormat.includes("*")     && this.fail(`Tag format "${this._tagFormat}" does not contain *.`);
            this.debug("Valid tag format: %s", this._tagFormat);
        }

        if (!this._packageName) {
            const { groups:{ name } } = this._packageName.match(/(?<name>[^\/]+)\.[a-z]+$/i);
            this._packageName = name;
            this.debug(`Package name not specified, extracted from PROJECT_FILE_PATH: "${this._packageName}"`);
        }
        !this._packageName                     && this.fail(`Package name must be specified.`);
        // Where to search for NuGet packages
        this._nugetSearchPath = path.dirname(this._projectFilePath);

    }

    /*
     * Check NuGet server if package exists and if specified version of that package exists.
     */
    private async checkNugetPackageExistsAsync(packageName: string, version: string): Promise<boolean> {
        const url = `${this._nugetSource}/v3-flatcontainer/${this._packageName}/index.json`;
        this.info(`[checkNugetPackageExistsAsync] Checking if nuget package exists on NuGet server: \"${url}\"`);
        return new Promise((packageVersionExists) => {
            https.get(url, (res: IncomingMessage) => {
                let data = "";
                
                if (res.statusCode == 404) {
                    this.debug(`NuGet server returned HTTP status code ${res.statusCode}: Package "${packageName}" does not exist.`);
                    packageVersionExists(false);
                }

                if (res.statusCode != 200) {
                    throw new Error(`NuGet server returned nexpected HTTP status code ${res.statusCode}: ${res.statusMessage}. Assuming failure.`);
                    packageVersionExists(false);
                }

                res.on('data', chunk => { data += chunk }) 
    
                res.on('end', () => {
                    // We should now have something like: { "versions": [ "1.0.0", "1.0.1" ] }
                    // Parse JSON and check if the version exists
                    const packages: IPackageVersions = JSON.parse(data);
                    const exists = packages.versions.includes(version);
                    this.debug(`NuGet server returned: ${packages.versions.length} package versions. Package version "${version}" is${exists ? "": " not"} in list.`);
                    packageVersionExists(exists);
                });

                res.on("error", e => {
                    this.fail(e);
                    packageVersionExists(false);
                });
            }) 
        })
    }

    /**
     * Rebuild the project
     */
    private async rebuildProjectAsync(): Promise<void> {
        this.info(`[rebuildProjectAsync] Rebuilding project: \"${this._projectFilePath}\"`);
        await this.executeAsync("dotnet", ["build", "-c", "Release", this._projectFilePath]);
    }

    /**
     * Package the project
     */
    private async packageProjectAsync(): Promise<string> {
        this.info(`[packageProjectAsync] Packaging project: \"${this._projectFilePath}\" to "${this._nugetSearchPath}"`);

        // Remove existing packages
        fs.readdirSync(this._nugetSearchPath).filter((fn:string) => /\.s?nupkg$/.test(fn)).forEach((fn:string) => fs.unlinkSync(fn))

        // Package new
        let params = ["pack", "-c", "Release"];
        if (this._includeSymbols){
            params.push("--include-symbols");
            params.push("-p:SymbolPackageFormat=snupkg");
        }
        params.push(this._projectFilePath);
        params.push("-o");
        params.push(this._nugetSearchPath);

        await this.executeAsync("dotnet", params);

        const packages = fs.readdirSync(this._nugetSearchPath).filter((fn:string) => fn.endsWith("nupkg"))
        return packages.join(", ");
    }

    private async publishPackageAsync(): Promise<void> {
        this.info(`[publishPackageAsync] Publishing package "${this._nugetSearchPath}/*.nupkg"`);
        let params=["dotnet", "nuget", "push", `${this._nugetSearchPath}/*.nupkg`, "-s", `${this._nugetSource}/v3/index.json`, "--skip-duplicate", "--force-english-output" ];
        if (!this._includeSymbols)
            params.push("--no-symbols");
        
        // Separate param array that is safe to log (no nuget key)
        let paramsLogSafe = params.concat(["-k", "NUGET_KEY_HIDDEN"]);
        params = params.concat(["-k", this._nugetKey]);
    
        await this.executeAsync("dotnet", params, paramsLogSafe);
    }

    private async gitCommitTagAsync(): Promise<void> {
        const tag = this._tagFormat.replace("*", this._packageVersion);
        this.info(`[gitCommitTagAsync] Creating tag: ${tag}`);

        await this.executeAsync("git", ["tag", tag]);
        await this.executeAsync("git", ["push", "origin", tag]);

        this.outputVariable("VERSION", tag);
    }
}

// Run the action
(new Action()).run();