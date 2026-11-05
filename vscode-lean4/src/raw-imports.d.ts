// Webpack imports these scripts as strings (`asset/source` in `webpack.config.js`).
declare module '*.sh' {
    const content: string
    export default content
}
declare module '*.ps1' {
    const content: string
    export default content
}
