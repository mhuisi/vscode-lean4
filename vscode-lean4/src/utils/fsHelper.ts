/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {promises, PathLike } from 'fs';
import path = require('path');

/**
    Helper used to replace fs.existsSync (using existsSync to check for the existence
    of a file before calling fs.open(), fs.readFile() or fs.writeFile() is not recommended.
    Doing so introduces a race condition, since other processes may change the file's state between the two calls.
    Instead, user code should open/read/write the file directly and handle the error raised if the file does not exist.)
    param: pathFile - A string representing a PathLike

    returns Promise<boolean> that represents if a file exist
**/
export async function fileExists(pathFile: PathLike): Promise<boolean> {
    return await promises.access(pathFile).then(() => true, () => false);
}

/**
 * This helper function is used to check if an specific file is in certain Folder.
 * @param file string that contains a file name that will be checked if it exists in a certain folder.
 * @param folder string that contains a folder name where it will check if a certain file exists
 * @returns a boolean that says if the file exists in folder
 */
export function isFileInFolder(file: string, folder: string){
    const relative = path.relative(folder, file)
    const isSubdir = relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
    return isSubdir
}
