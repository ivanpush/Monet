import { exec } from 'child_process';
import { promisify } from 'util';

// Promisified exec for running shell commands
export const execAsync = promisify(exec);
