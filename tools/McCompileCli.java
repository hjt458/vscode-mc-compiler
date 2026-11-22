import dev.programmablefurnace.base.CompilerAnalyzer;
import dev.programmablefurnace.base.CompilerAnalyzer.CompileResult;
import dev.programmablefurnace.compiler.lex.CompileError;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Standalone command-line front-end for the ProgrammableFurnace {@code .mc}
 * compiler.
 *
 * <p>The mod's compiler front-end ({@code lex -> syntax -> sem}) has no
 * Minecraft dependency, so it can be built and run outside the game. This class
 * is the thin entry point a host plugin shells out to: it reads each path given
 * on the command line, compiles it with the same
 * {@link CompilerAnalyzer#compile(String, String)} the compiler block uses, and
 * prints one JSON array on stdout.</p>
 *
 * <p>Output shape (one element per input, in argument order):</p>
 * <pre>
 * [{"file":"...","state":"EXECUTABLE","module":"冶炼","bytes":5356,"lines":113,
 *   "errors":[{"code":"S05","line":4,"col":13,"message":"..."}]}]
 * </pre>
 *
 * <p>{@code state} is a {@code ContentState} name; {@code module} is the name
 * registered by {@code MODULE("...")} or the empty string when compilation
 * failed before that point; {@code bytes}/{@code lines} describe the source
 * that was read.</p>
 *
 * <p>Run with {@code -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8} (or a UTF-8
 * console) so Chinese identifiers and messages survive the trip.</p>
 */
public final class McCompileCli {

    public static void main(String[] args) {
        PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        StringBuilder json = new StringBuilder("[");
        boolean first = true;
        for (String arg : args) {
            if (arg == null || arg.isBlank()) continue;
            if (!first) json.append(',');
            first = false;
            json.append(compileOne(arg));
        }
        json.append(']');
        out.println(json);
        out.flush();
    }

    /** Compile one file; never throws — a bad path becomes an IO error entry. */
    private static String compileOne(String file) {
        Path path = Paths.get(file);
        String fileName = path.getFileName() == null ? file : path.getFileName().toString();
        String stem = fileName.endsWith(".mc")
                ? fileName.substring(0, fileName.length() - 3)
                : fileName;

        String source;
        try {
            source = Files.readString(path, StandardCharsets.UTF_8);
        } catch (Exception ex) {
            String message = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
            return "{\"file\":" + q(file)
                    + ",\"state\":\"FAILED\",\"module\":\"\",\"bytes\":0,\"lines\":0"
                    + ",\"errors\":[{\"code\":\"IO\",\"line\":0,\"col\":0,\"message\":"
                    + q("cannot read file: " + message) + "}]}";
        }

        CompileResult result = CompilerAnalyzer.compile(stem, source);
        String module = result.table() == null || result.table().moduleName() == null
                ? ""
                : result.table().moduleName();

        StringBuilder json = new StringBuilder();
        json.append("{\"file\":").append(q(file))
                .append(",\"state\":").append(q(result.state().name()))
                .append(",\"module\":").append(q(module))
                .append(",\"bytes\":").append(source.getBytes(StandardCharsets.UTF_8).length)
                .append(",\"lines\":").append(countLines(source))
                .append(",\"errors\":[");
        boolean first = true;
        for (CompileError error : result.errors()) {
            if (!first) json.append(',');
            first = false;
            json.append("{\"code\":").append(q(error.code().code()))
                    .append(",\"line\":").append(error.pos().line())
                    .append(",\"col\":").append(error.pos().col())
                    .append(",\"message\":").append(q(error.message()))
                    .append('}');
        }
        return json.append("]}").toString();
    }

    private static int countLines(String text) {
        int lines = 0;
        int start = 0;
        while (start < text.length()) {
            int next = text.indexOf('\n', start);
            if (next < 0) {
                return lines + 1;
            }
            lines += 1;
            start = next + 1;
        }
        return lines;
    }

    /** Minimal JSON string escaping; the panel only needs valid JSON. */
    private static String q(String value) {
        if (value == null) return "\"\"";
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i += 1) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.append('"').toString();
    }
}
